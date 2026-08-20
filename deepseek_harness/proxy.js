'use strict';

/**
 * DeepSeek Harness add-on — HTTP/WebSocket proxy for HA Ingress.
 *
 * 1. Strips the X-Ingress-Path prefix from URLs before forwarding to DSH.
 * 2. Rewrites HTML responses to inject <base> tags, loopback fix scripts,
 *    ingress path patching, and the one-click update UI.
 * 3. Rewrites dsh-client-connection's client.js to force isLoopback=true.
 * 4. Rewrites /api/host.describe to return hostname=127.0.0.1.
 * 5. Relays /__dsh_update* endpoints to the bridge API, injecting the
 *    shared token so browser-side code never holds it.
 * 6. Proxies WebSocket upgrade requests with Host/Origin header override.
 *
 * Environment variables:
 *   DSH_API_PORT   — bridge API port (default 3082)
 *   DSH_API_TOKEN  — shared secret for bridge API auth
 */

const http = require('http');
const net = require('net');

const DSH_PORT = 3081;
const PROXY_PORT = 3080;
const BRIDGE_PORT = parseInt(process.env.DSH_API_PORT || '3082', 10);
const BRIDGE_TOKEN = process.env.DSH_API_TOKEN || '';

function log() {
    const args = ['[' + new Date().toISOString() + ']'].concat(Array.from(arguments));
    console.log.apply(console, args);
}

const server = http.createServer((req, res) => {
    const ingressPath = req.headers['x-ingress-path'] || '';
    const reqId = Math.random().toString(36).slice(2, 8);

    // 诊断端点：用于独立验证代理是否正常运行
    if (req.url === '/__proxy_diag') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            proxy: 'running',
            dsh_port: DSH_PORT,
            ingress: ingressPath || '(none)',
            remote: req.headers['x-remote-user-id'] || '(none)',
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // 重要：先去除 Ingress 前缀，后续所有路径判断都基于剥离后的 targetPath
    let targetPath = req.url;
    if (ingressPath && targetPath.startsWith(ingressPath)) {
        targetPath = targetPath.slice(ingressPath.length);
        if (targetPath === '') {
            targetPath = '/';
        }
    }

    // 一键更新端点：/__dsh_update* -> bridge API :3082（代理注入 token，浏览器无需持有）
    // 仅允许 GET/POST；POST 由 bridge 内部做 fail-closed 鉴权
    // 安全：此通道会主动注入 BRIDGE_TOKEN，等效于把 bridge 的 token 鉴权架空，
    // 因此必须限定来源为 HA ingress（带 x-ingress-path 头），
    // 防止容器网络内其它 addon/进程直连 3080 免 token 触发 npm install/容器重启。
    if (targetPath.indexOf('/__dsh_update') === 0) {
        if (!ingressPath) {
            log('[HTTP-' + reqId + ']', 'update denied: no x-ingress-path (non-ingress source)');
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'forbidden: update endpoint is ingress-only' }));
            return;
        }
        const bridgePath = '/api' + targetPath.slice('/__dsh_update'.length);
        const headers = Object.assign({}, req.headers);
        delete headers['host'];
        delete headers['origin'];
        delete headers['x-ingress-path'];
        if (BRIDGE_TOKEN) headers['Authorization'] = 'Bearer ' + BRIDGE_TOKEN;
        const b = http.request({
            hostname: '127.0.0.1',
            port: BRIDGE_PORT,
            path: bridgePath,
            method: req.method,
            headers: headers
        }, (bres) => {
            log('[HTTP-' + reqId + ']', 'bridge relay:', req.method, bridgePath, '->', bres.statusCode);
            res.writeHead(bres.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            bres.pipe(res);
        });
        b.on('error', (e) => {
            if (res.headersSent) return;
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'bridge relay failed: ' + e.message }));
        });
        req.pipe(b);
        return;
    }

    log('[HTTP-' + reqId + ']', req.method, 'original:', req.url, '-> target:', targetPath);

    const options = {
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: targetPath,
        method: req.method,
        headers: Object.assign({}, req.headers)
    };

    delete options.headers['x-ingress-path'];
    delete options.headers['proxy-connection'];
    delete options.headers['connection'];
    // 删除原有的 Host/Origin 头部（大小写都删，避免重复）
    delete options.headers['Host'];
    delete options.headers['host'];
    delete options.headers['Origin'];
    delete options.headers['origin'];
    // 关键：DSH 后端通过 isTrustedApiRequest 检查请求合法性：
    //   1. Host 头部必须是 loopback (127.0.0.1/localhost) 或 trustedHosts
    //   2. Origin 头部（如果有）必须与 Host 的 host 部分匹配
    // 代理从浏览器收到的是 Host: api.homediy.top:8443, Origin: https://api.homediy.top:8443
    // 必须覆盖为 DSH 实际地址，否则 origin.host !== host -> 403
    // Node.js http.request 会自动从 hostname + port 生成正确的 Host header
    // origin 需要显式设置
    options.headers['origin'] = 'http://127.0.0.1:' + DSH_PORT;

    // DEBUG: 记录发送给 DSH 后端的请求头
    log('[HTTP-' + reqId + ']', 'sending headers:', JSON.stringify({
        host: options.headers['host'],
        Host: options.headers['Host'],
        origin: options.headers['origin'],
        Origin: options.headers['Origin']
    }));

    const cleanHeaders = (headers) => {
        const h = Object.assign({}, headers);
        delete h['transfer-encoding'];
        delete h['content-length'];
        return h;
    };

    const proxyReq = http.request(options, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html');

        log('[HTTP-' + reqId + ']', 'response:', proxyRes.statusCode, 'type:', contentType);

        // 提取路径部分（去除查询参数），用于 URL 匹配
        // 浏览器加载 ES Module 时可能带 ?rev=xxx 或 ?t=timestamp 等缓存清除参数
        const pathOnly = targetPath.split('?')[0];

        // ===== 关键修复：改写 dsh-client-connection 模块，强制 isLoopback = true =====
        // DSH 前端通过 connection.isLoopback 决定设置持久化后端（host 持久化 或 memory 仅内存）：
        //   - isLoopback=true  -> SettingsScopeController(api, spec, "host")  -> 设置通过 RPC 存到后端 settings.yaml
        //   - isLoopback=false -> 使用 "memory"，所有设置、弹窗状态、语言选择一律不保存（刷新即丢）
        // isLoopback 由前端 pageLocation.hostname 判断（client.js: isLoopbackHostname(...)）。
        // 在 HA Ingress 下 hostname 是外部域名（如 api.homediy.top），永远判定为非 loopback。
        // 注入脚本覆盖 Location.prototype.hostname 因浏览器不可配置(Non-configurable)而失效。
        // 因此这里在代理层直接改写该插件模块源码：把 isLoopback 计算替换为常量 true。
        if (pathOnly.endsWith('/plugins/@deepseek-ai/dsh-client-connection/client.js') &&
            (contentType.includes('javascript') || contentType.includes('application/json') || isHtml)) {
            let body = '';
            proxyRes.on('data', (chunk) => { body += chunk.toString(); });
            proxyRes.on('end', () => {
                if (body.indexOf('isLoopback') !== -1) {
                    // 未压缩 ESM 精确替换：isLoopback: (...isLoopbackHostname...) -> isLoopback: true
                    body = body.replace(
                        /isLoopback:\s*pageLocation\s*===\s*void\s*0\s*\|\|\s*isLoopbackHostname\(\s*pageLocation\.hostname\s*\)\s*?[,;}]/g,
                        'isLoopback: true,'
                    );
                    // 若未命中精确模式，做兜底：将其它任何非 true 的 isLoopback: 赋值强制为 true
                    if (body.indexOf('isLoopback: true') === -1) {
                        body = body.replace(/isLoopback:\s*(?!true)[^,]+,/g, 'isLoopback: true,');
                    }
                    // 降级检测：精确替换 + 兜底替换都未命中 -> 上游 DSH 可能改了变量名/结构
                    if (body.indexOf('isLoopback: true') === -1) {
                        log('[HTTP-' + reqId + ']', 'WARNING: DSH client.js isLoopback pattern changed upstream! ' +
                            'Persistence may be degraded (settings not saved). Please check DSH version.');
                    } else {
                        log('[HTTP-' + reqId + ']', 'dsh-client-connection isLoopback forced to true');
                    }
                }
                const headers = cleanHeaders(proxyRes.headers);
                headers['content-length'] = Buffer.byteLength(body, 'utf-8');
                headers['content-type'] = 'application/javascript; charset=utf-8';
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
            });
        } else if (isHtml && ingressPath) {
            let body = '';
            proxyRes.on('data', (chunk) => { body += chunk.toString(); });
            proxyRes.on('end', () => {
                const baseHref = ingressPath + '/';

                body = body.replace(/(src|href)\s*=\s*["']\/([^"']+)["']/g, function(m, attr, path) {
                    return attr + '="' + ingressPath + '/' + path + '"';
                });
                body = body.replace(/"url"\s*:\s*"\/plugins\//g, '"url":"' + ingressPath + '/plugins/');

                // 注入 Ingress 路径修复脚本：patch fetch 和 WebSocket 以使用正确的 Ingress 路径
                // 关键：DSH 客户端代码使用 new URL(path, location.origin) 构造 URL 对象，
                // 然后直接传给 fetch(new URL(...))，所以 url 参数是 URL 对象，不是字符串！
                // 注入移动端响应式样式
                // 注意：不再改动三栏布局（sidebarCol/centerCol/detailsCol），
                // 只修复对话框在手机上可能被遮挡或不可见的问题。
                // DSH 自身的三栏布局在小屏上会自然压缩，无需干预。
                const mobileCss = [
                    '<style>',
                    '@media (max-width: 768px) {',
                    // 对话框：确保全屏可见，但不强制覆盖整个屏幕
                    '  div[class*="dialog"], div[role="dialog"], div[class*="modal"] {',
                    '    max-width: 100vw !important;',
                    '    max-height: 100vh !important;',
                    '    box-sizing: border-box !important;',
                    '  }',
                    // 对话框内部内容区域：自适应宽度
                    '  div[class*="dialog"] > :first-child,',
                    '  div[role="dialog"] > :first-child,',
                    '  div[class*="modal"] > :first-child {',
                    '    max-width: 100% !important;',
                    '    box-sizing: border-box !important;',
                    '  }',
                    // 底部安全区域
                    '  body {',
                    '    padding-bottom: env(safe-area-inset-bottom, 0px) !important;',
                    '  }',
                    // 确保所有交互元素不被遮挡
                    '  input, select, textarea, button {',
                    '    font-size: 16px !important;',
                    '  }',
                    '}',
                    '</style>'
                ].join('\n');

                // ===== 核心修复：让 DSH 客户端认为运行在 loopback 环境 =====
                // DSH 通过检查 location.hostname 判断是否为回环地址：
                //   - 是回环地址 → isLoopback = true → 持久化到后端（可保存）
                //   - 非回环地址 → isLoopback = false → 仅存内存（刷新丢失）
                // HA Ingress 的 hostname 是 api.homediy.top，不是回环地址
                // 所以：弹窗状态、语言设置等所有配置都存不住
                // 修复：在 DSH 客户端模块加载前，劫持 hostname 返回 127.0.0.1
                //
                // 关键：在 Chromium 中，window.location 是直接定义在 window 上的不可配置(non-configurable)属性，
                // 之前的 Window.prototype 方式无法获取到描述符，导致脚本静默失败。
                // 正确做法：覆盖 Location.prototype.hostname，它在 Chromium 中是可配置的 getter。
                // Location.prototype 上的 hostname 改变会影响所有 Location 实例（包括 window.location）。
                const loopbackFixScript = [
                    '<script>',
                    '(function(){',
                    '  var LOCATION_WARN = function(msg) {',
                    '    try { console.warn("[loopback] " + msg); } catch(e) {}',
                    '  };',
                    '  // 方法1（首选）：覆盖 Location.prototype.hostname（Chromium 中最可靠）',
                    '  try {',
                    '    if (typeof Location !== "undefined") {',
                    '      var h = Object.getOwnPropertyDescriptor(Location.prototype, "hostname");',
                    '      if (h && h.configurable) {',
                    '        Object.defineProperty(Location.prototype, "hostname", {',
                    '          get: function() { return "127.0.0.1"; },',
                    '          configurable: true',
                    '        });',
                    '        var hostDesc = Object.getOwnPropertyDescriptor(Location.prototype, "host");',
                    '        if (hostDesc && hostDesc.configurable) {',
                    '          Object.defineProperty(Location.prototype, "host", {',
                    '            get: function() { return "127.0.0.1:" + this.port; },',
                    '            configurable: true',
                    '          });',
                    '        }',
                    '        LOCATION_WARN("Location.prototype.hostname patched");',
                    '      } else { LOCATION_WARN("hostname not configurable"); }',
                    '    } else { LOCATION_WARN("Location not available"); }',
                    '  } catch(e) { LOCATION_WARN("method1 failed: " + e.message); }',
                    '})();',
                    '</script>'
                ].join('\n');

                // crypto.randomUUID polyfill（部分 WebView 不支持）
                const cryptoPolyfillScript = [
                    '<script>',
                    '(function(){',
                    "  try {",
                    "    if (typeof crypto !== 'undefined' && !crypto.randomUUID) {",
                    "      crypto.randomUUID = function() {",
                    "        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {",
                    "          var r = Math.random() * 16 | 0;",
                    "          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);",
                    "        });",
                    "      };",
                    "    }",
                    "  } catch(e) {}",
                    '})();',
                    '</script>'
                ].join('\n');

                const ingressFixScript = [
                    '<script>',
                    '(function(){',
                    '  var BASE = "' + ingressPath + '";',
                    '  if (!BASE) return;',
                    '  var ORIGIN = window.location.origin;',
                    '  function rewrite(url) {',
                    '    var isStr = typeof url === "string";',
                    '    var path = isStr ? url : (url && url.pathname) || "";',
                    '    // 避免二次重写：URL 已包含 ingress 路径前缀则跳过',
                    '    if (path.startsWith(BASE)) { return null; }',
                    '    if (path.startsWith("/api/")) {',
                    '      // 仅 URL 对象才有 query；字符串取空，否则 url.search 是 String.prototype.search 函数',
                    '      var qs = isStr ? "" : (url && url.search) || "";',
                    '      return ORIGIN + BASE + path + qs;',
                    '    }',
                    '    return null;',
                    '  }',
                    '  var origFetch = window.fetch;',
                    '  window.fetch = function(url, opts) {',
                    '    var rewritten = rewrite(url);',
                    '    if (rewritten) { console.log("[ingress] fetch:", (url.pathname || url), "->", rewritten); url = rewritten; }',
                    '    return origFetch.call(this, url, opts);',
                    '  };',
                    '  var OrigWS = window.WebSocket;',
                    '  window.WebSocket = function(url, protocols) {',
                    '    var rewritten = rewrite(url);',
                    '    if (rewritten) { console.log("[ingress] WS:", (url.pathname || url), "->", rewritten); url = rewritten; }',
                    '    return new OrigWS(url, protocols);',
                    '  };',
                    '})();',
                    '</script>'
                ].join('\n');

                // ===== localStorage 诊断脚本 =====
                // 检查 localStorage 状态，记录对话数据和会话数据的持久化情况
                // 用户可在浏览器控制台查看日志以诊断问题
                const storageDiagScript = [
                    '<script>',
                    '(function(){',
                    '  var LS_WARN = function(msg) {',
                    '    try { console.warn("[storage] " + msg); } catch(e) {}',
                    '  };',
                    '  try {',
                    '    var avail = typeof localStorage !== "undefined";',
                    '    LS_WARN("localStorage available: " + avail);',
                    '    if (avail) {',
                    '      var keys = Object.keys(localStorage);',
                    '      LS_WARN("localStorage keys: " + JSON.stringify(keys));',
                    '      var chatKey = keys.find(function(k) { return k.indexOf("dsh.conversation.chat") !== -1; });',
                    '      var sessKey = keys.find(function(k) { return k.indexOf("dsh.sessions.current") !== -1; });',
                    '      if (chatKey) { LS_WARN("chat data found: " + chatKey + " length=" + localStorage.getItem(chatKey).length); }',
                    '      else { LS_WARN("WARNING: No chat data in localStorage!"); }',
                    '      if (sessKey) { LS_WARN("session data found: " + sessKey + " value=" + localStorage.getItem(sessKey)); }',
                    '      else { LS_WARN("WARNING: No session data in localStorage!"); }',
                    '    }',
                    '  } catch(e) { LS_WARN("ERROR: " + e.message); }',
                    '})();',
                    '</script>'
                ].join('\n');

                // ===== 一键更新按钮（DESIGN.md §8）=====
                // 浮动按钮始终显示（显示当前版本），调用 /__dsh_update* 由 HTTP 代理中转。
                // 同时通过 MutationObserver 注入到 DSH 设置页面中的按钮区域。
                // 流程：检查更新(GET status) -> 一键更新(POST) -> 轮询 result -> 容器重启。
                const updateUiScript = [
                    '<style>',
                    '#dsh-update-btn { position:fixed; right:16px; bottom:16px; z-index:99999; ',
                    '  background:#185fa5; color:#fff; border:none; border-radius:20px; padding:8px 16px;',
                    '  font-size:13px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.25); display:flex; align-items:center; gap:4px; }',
                    '#dsh-update-btn:hover { background:#0c447c; }',
                    '#dsh-update-btn.loading { opacity:0.6; pointer-events:none; }',
                    '#dsh-update-btn .dot { width:6px; height:6px; border-radius:50%; display:inline-block; margin-left:4px; }',
                    '#dsh-update-btn .dot.green { background:#4caf50; }',
                    '#dsh-update-btn .dot.orange { background:#ff9800; }',
                    '#dsh-update-btn .dot.gray { background:#9e9e9e; }',
                    '#dsh-update-status { position:fixed; right:16px; bottom:52px; z-index:99999; ',
                    '  background:rgba(20,20,20,.85); color:#fff; padding:8px 12px; border-radius:8px;',
                    '  font-size:12px; max-width:320px; display:none; white-space:pre-line; }',
                    // 设置页面更新按钮样式
                    '#dsh-settings-update { margin:12px 0; display:none; }',
                    '#dsh-settings-update button { ',
                    '  background:#185fa5; color:#fff; border:none; border-radius:6px; padding:8px 16px;',
                    '  font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }',
                    '#dsh-settings-update button:hover { background:#0c447c; }',
                    '</style>',
                    '<button id="dsh-update-btn">DSH <span id="dsh-ver">?</span><span class="dot gray" id="dsh-dot"></span></button>',
                    '<div id="dsh-update-status"></div>',
                    '<div id="dsh-settings-update"><button id="dsh-settings-update-btn">🔄 检查 DSH 更新</button></div>',
                    '<script>',
                    '(function(){',
                    '  var BASE = "' + ingressPath + '";',
                    '  var btn = document.getElementById("dsh-update-btn");',
                    '  var verEl = document.getElementById("dsh-ver");',
                    '  var dotEl = document.getElementById("dsh-dot");',
                    '  var box = document.getElementById("dsh-update-status");',
                    '  var settingsBtn = document.getElementById("dsh-settings-update");',
                    '  var settingsBtnInner = document.getElementById("dsh-settings-update-btn");',
                    '  function api(path, opts) {',
                    '    var url = BASE + path;',
                    '    return fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));',
                    '  }',
                    '  function show(msg, isErr) { box.style.display = "block"; box.textContent = msg; box.style.border = isErr ? "1px solid #e24b4a" : "1px solid #1d9e75"; }',
                    '  function hideBox() { box.style.display = "none"; }',
                    '  function doUpdate() {',
                    '    if (btn.dataset.busy === "1") return;',
                    '    btn.dataset.busy = "1"; btn.classList.add("loading");',
                    '    api("/__dsh_update/update/status").then(function(r){ return r.json(); }).then(function(s){',
                    '      if (!s.ok) { show("更新服务不可用: " + (s.error || "unknown"), true); btn.dataset.busy = "0"; btn.classList.remove("loading"); return; }',
                    '      var cur = s.current + (s.usingVendor ? " (vendor)" : " (builtin)");',
                    '      var next = s.next || "";',
                    '      if (next && next !== s.current) {',
                    '        if (confirm("当前: " + cur + "\\n上游最新: " + next + "\\n\\n一键更新到 " + next + "？更新完成后容器将自动重启。")) {',
                    '          show("正在更新到 " + next + " ...");',
                    '          api("/__dsh_update/update", { method: "POST", body: JSON.stringify({ channel: "next" }) }).then(function(r){ return r.json(); }).then(function(u){',
                    '            if (u.ok) { show("更新中... 完成后容器将自动重启，请稍候刷新页面。"); setTimeout(function(){ location.reload(); }, 8000); }',
                    '            else { show("更新失败: " + (u.error || "unknown"), true); btn.dataset.busy = "0"; btn.classList.remove("loading"); }',
                    '          }).catch(function(e){ show("更新请求失败: " + e.message, true); btn.dataset.busy = "0"; btn.classList.remove("loading"); });',
                    '        } else { btn.dataset.busy = "0"; btn.classList.remove("loading"); }',
                    '      } else {',
                    '        show("当前已是最新版本\\n" + cur);',
                    '        btn.dataset.busy = "0"; btn.classList.remove("loading");',
                    '        setTimeout(hideBox, 3000);',
                    '      }',
                    '    }).catch(function(e){ show("获取更新状态失败: " + e.message, true); btn.dataset.busy = "0"; btn.classList.remove("loading"); });',
                    '  }',
                    '  btn.addEventListener("click", doUpdate);',
                    '  settingsBtnInner.addEventListener("click", doUpdate);',
                    '  // 加载更新状态',
                    '  api("/__dsh_update/update/status").then(function(r){ return r.json(); }).then(function(s){',
                    '    console.log("[DSH Update] status:", s);',
                    '    verEl.textContent = s.current || "?";',
                    '    if (s.ok && s.next && s.next !== s.current) {',
                    '      dotEl.className = "dot orange";',
                    '      btn.title = "新版本可用: " + s.next;',
                    '      settingsBtn.style.display = "block";',
                    '      settingsBtnInner.textContent = "🔄 更新到 " + s.next;',
                    '    } else {',
                    '      dotEl.className = "dot green";',
                    '      btn.title = "已是最新版本";',
                    '    }',
                    '  }).catch(function(e){',
                    '    console.warn("[DSH Update] status fetch failed:", e);',
                    '    verEl.textContent = "?";',
                    '    dotEl.className = "dot gray";',
                    '    btn.title = "更新服务不可用";',
                    '  });',
                    '  // MutationObserver: 检测设置页面加载，注入更新按钮',
                    '  var obs = new MutationObserver(function() {',
                    '    var settingsArea = document.querySelector("[class*=\\"settings\\"], [class*=\\"Settings\\"], [class*=\\"config\\"], [class*=\\"Config\\"]");',
                    '    if (settingsArea && !settingsArea.querySelector("#dsh-settings-update")) {',
                    '      var clone = settingsBtn.cloneNode(true);',
                    '      clone.id = "dsh-settings-update-clone";',
                    '      clone.style.display = "block";',
                    '      clone.querySelector("button").addEventListener("click", doUpdate);',
                    '      settingsArea.insertBefore(clone, settingsArea.firstChild);',
                    '    }',
                    '  });',
                    '  obs.observe(document.body, { childList: true, subtree: true });',
                    '})();',
                    '</script>'
                ].join('\n');

                const baseTag = '<base href="' + baseHref + '">\n';
                body = body.replace('<head>', '<head>' + baseTag + mobileCss + loopbackFixScript + cryptoPolyfillScript + ingressFixScript + storageDiagScript + updateUiScript);

                const headers = cleanHeaders(proxyRes.headers);
                headers['content-length'] = Buffer.byteLength(body, 'utf-8');
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
                log('[HTTP-' + reqId + ']', 'HTML rewritten with base:', baseHref);
            });
        } else if (pathOnly === '/api/host.describe' && contentType.includes('json')) {
            // 拦截 host.describe API，将 hostname 改为 127.0.0.1
            // DSH 后端通过 host.describe 返回的 hostname 判断 isLoopback，
            // HA Ingress 环境下 hostname 是外部域名，导致 isLoopback = false，
            // 所有设置使用 persistence = "memory"，刷新丢失。
            // 这里将 hostname 改为 127.0.0.1，使 DSH 使用 persistence = "host"。
            let body = '';
            proxyRes.on('data', (chunk) => { body += chunk.toString(); });
            proxyRes.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    let patched = false;
                    // 递归修改所有 hostname 字段
                    (function patchHostname(obj) {
                        if (obj && typeof obj === 'object') {
                            for (const key of Object.keys(obj)) {
                                if (key === 'hostname' && typeof obj[key] === 'string') {
                                    obj[key] = '127.0.0.1';
                                    patched = true;
                                } else {
                                    patchHostname(obj[key]);
                                }
                            }
                        }
                    })(data);
                    body = JSON.stringify(data);
                    if (patched) {
                        log('[HTTP-' + reqId + ']', 'host.describe patched: hostname -> 127.0.0.1');
                    } else {
                        log('[HTTP-' + reqId + ']', 'WARNING: host.describe response had no hostname field to patch. ' +
                            'DSH may have changed the response structure upstream.');
                    }
                } catch(e) {
                    log('[HTTP-' + reqId + ']', 'host.describe patch error:', e.message);
                }
                const headers = cleanHeaders(proxyRes.headers);
                headers['content-length'] = Buffer.byteLength(body, 'utf-8');
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
            });
        } else {
            res.writeHead(proxyRes.statusCode, cleanHeaders(proxyRes.headers));
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        if (res.headersSent) return;
        log('[HTTP-' + reqId + ']', 'ERROR:', err.message);
        res.writeHead(502);
        res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
    const ingressPath = req.headers['x-ingress-path'] || '';
    const wsId = Math.random().toString(36).slice(2, 8);

    let targetPath = req.url;
    if (ingressPath && targetPath.startsWith(ingressPath)) {
        targetPath = targetPath.slice(ingressPath.length);
        if (targetPath === '') {
            targetPath = '/';
        }
    }

    // 提取关键 WebSocket 头部
    const wsKey = req.headers['sec-websocket-key'] || '(none)';
    const wsVersion = req.headers['sec-websocket-version'] || '(none)';
    const wsProtocol = req.headers['sec-websocket-protocol'] || '(none)';
    const origin = req.headers['origin'] || '(none)';

    log('[WS-' + wsId + ']', 'UPGRADE: original:', req.url, '-> target:', targetPath);
    log('[WS-' + wsId + ']', '  headers: key=' + wsKey + ' version=' + wsVersion + ' protocol=' + wsProtocol + ' origin=' + origin);

    let connected = false;
    const proxySocket = net.connect(DSH_PORT, '127.0.0.1', () => {
        connected = true;
        var upgradeReq = req.method + ' ' + targetPath + ' HTTP/1.1\r\n';
        for (var i = 0; i < req.rawHeaders.length; i += 2) {
            var key = req.rawHeaders[i];
            var value = req.rawHeaders[i + 1];
            if (key.toLowerCase() === 'x-ingress-path' || key.toLowerCase() === 'proxy-connection') continue;
            // 覆盖 Host 和 Origin 头部为 DSH 实际地址
            // DSH 后端 isTrustedApiRequest 检查：
            //   1. Host 必须是 loopback 或 trustedHosts
            //   2. Origin（如果有）必须与 Host 的 host 部分一致
            // 覆盖 Host 头部为 DSH 实际地址
            if (key.toLowerCase() === 'host') { value = '127.0.0.1:' + DSH_PORT; }
            // 覆盖 Origin 头部为 DSH 实际地址，否则浏览器发送的 Origin: https://api.homediy.top:8443
            // 与 Host: 127.0.0.1:3081 不匹配，导致 403
            if (key.toLowerCase() === 'origin') { value = 'http://127.0.0.1:' + DSH_PORT; }
            upgradeReq += key + ': ' + value + '\r\n';
        }
        upgradeReq += '\r\n';
        proxySocket.write(upgradeReq + head.toString('binary'), 'binary');
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        log('[WS-' + wsId + ']', 'Forwarded to DSH backend');
    });

    proxySocket.on('error', (err) => {
        log('[WS-' + wsId + ']', 'ERROR:', err.message, '(connected:', connected + ')');
        socket.destroy();
    });

    proxySocket.on('close', () => {
        log('[WS-' + wsId + ']', 'Connection closed');
    });

    socket.on('error', () => {
        proxySocket.destroy();
    });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
    log('[DSH Addon] HTTP proxy listening on 0.0.0.0:' + PROXY_PORT);
    log('[DSH Addon] Diag endpoint: /__proxy_diag');
});