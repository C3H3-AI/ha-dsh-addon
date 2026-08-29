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
 * (plugin management is delegated to the dsh-market plugin's own UI)
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
    // 代理从浏览器收到的是 Host: <外部反代域名>:<port>, Origin: https://<外部反代域名>
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
        // 在 HA Ingress 下 hostname 是外部反代/Ingress 域名，永远判定为非 loopback。
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

                // ===== 通用 Ingress 路径修复脚本 =====
                // 核心问题：DSH SPA 通过 fetch/WebSocket/XHR/SSE 请求后端，但 HA Ingress
                // 要求所有请求必须带前缀 /api/hassio_ingress/<token>/。
                // 插件可以注册任意路径（/api/、/plugins/、/dsh-market/、/custom/...），
                // 无法穷举白名单，因此改为「通用拦截」：
                //
                // 规则：拦截所有同源请求，如果路径是相对路径（以 / 开头），
                // 统一加上 Ingress 前缀。不同源的请求（如 npm registry）不处理。
                //
                // 覆盖：fetch / WebSocket / XMLHttpRequest / EventSource(SSE)
                const ingressRewriteScript = [
                    '<script>',
                    '(function(){',
                    '  var BASE = "' + ingressPath + '";',
                    '  if (!BASE) return;',
                    '  var ORIGIN = window.location.origin;',
                    '',
                    '  // ===== 通用 URL 重写 =====',
                    '  // 返回重写后的 URL 字符串，或 null（无需重写）',
                    '  function rewrite(url) {',
                    '    var urlStr = (typeof url === "string") ? url : (url && (url.url || url.pathname || "")) || "";',
                    '    if (!urlStr) return null;',
                    '    // 已带前缀的不重复处理',
                    '    if (urlStr.indexOf(BASE) !== -1) return null;',
                    '    // 提取路径部分',
                    '    var path = urlStr;',
                    '    var abs = null;',
                    '    if (path.indexOf("://") > 0) {',
                    '      try {',
                    '        var u = new URL(path);',
                    '        // 只比较 host（hostname:port），忽略协议差异（https vs wss），',
                    '        // 否则 WebSocket 的 wss:// 与页面 https:// 会被误判为不同源而跳过补前缀。',
                    '        if (u.host !== new URL(ORIGIN).host) return null; // 不同源（如 npm registry）跳过',
                    '        abs = u;',
                    '        path = u.pathname + (u.search || "");',
                    '      } catch(e) { return null; }',
                    '    }',
                    '    // 只处理相对路径（以 / 开头）',
                    '    if (path.indexOf("/") !== 0) return null;',
                    '    // 保留原协议与 host（wss/https），补上 Ingress 前缀，同时保留 query 参数',
                    '    return (abs ? (abs.protocol + "//" + abs.host) : ORIGIN) + BASE + path;',
                    '  }',
                    '',
                    '  // ===== 1. 拦截 fetch（带调试日志）=====',
                    '  var origFetch = window.fetch;',
                    '  window.fetch = function(url, opts) {',
                    '    var rewritten = rewrite(url);',
                    '    if (rewritten) {',
                    '      console.log("[ingress] REWRITE:", typeof url === "string" ? url : (url && url.url), "->", rewritten);',
                    '      if (typeof url === "object" && url && url.url) {',
                    '        return origFetch.call(this, new Request(rewritten, url), opts);',
                    '      }',
                    '      url = rewritten;',
                    '    } else if (typeof url === "string" || (url && url.url)) {',
                    '      var urlStr = typeof url === "string" ? url : url.url;',
                    '      if (urlStr.indexOf("/") === 0 || urlStr.indexOf("://") > 0) {',
                    '        console.log("[ingress] SKIP:", urlStr, "- not matched");',
                    '      }',
                    '    }',
                    '    return origFetch.call(this, url, opts);',
                    '  };',
                    '',
                    '  // ===== 2. 拦截 WebSocket（保持 instanceof 兼容）=====',
                    '  var OrigWS = window.WebSocket;',
                    '  window.WebSocket = function(url, protocols) {',
                    '    var rewritten = rewrite(url);',
                    '    if (rewritten) { url = rewritten; }',
                    '    return new OrigWS(url, protocols);',
                    '  };',
                    '  window.WebSocket.prototype = OrigWS.prototype;',
                    '  window.WebSocket.CONNECTING = 0;',
                    '  window.WebSocket.OPEN = 1;',
                    '  window.WebSocket.CLOSING = 2;',
                    '  window.WebSocket.CLOSED = 3;',
                    '',
                    '  // ===== 3. 拦截 XMLHttpRequest =====',
                    '  var origOpen = XMLHttpRequest.prototype.open;',
                    '  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {',
                    '    var rewritten = rewrite(url);',
                    '    if (rewritten) { url = rewritten; }',
                    '    return origOpen.call(this, method, url, async, user, pass);',
                    '  };',
                    '',
                    '  // ===== 4. 拦截 EventSource (SSE) =====',
                    '  if (window.EventSource) {',
                    '    var OrigES = window.EventSource;',
                    '    window.EventSource = function(url, config) {',
                    '      var rewritten = rewrite(url);',
                    '      if (rewritten) { url = rewritten; }',
                    '      return new OrigES(url, config);',
                    '    };',
                    '    window.EventSource.prototype = OrigES.prototype;',
                    '  }',
                    '',
                    '  // ===== 5. 拦截动态 <script> 与 <iframe> 注入（懒加载 chunk / MCP连接器等）=====',
                    '  // 通用 fetch/XHR/WS/SSE 拦截覆盖不到两处：',
                    '  //  (1) dsh-better-sidebar 的 /sidebar/bundle/*.js 懒加载 chunk（<script> 注入）',
                    '  //  (2) dsh-mcp-connector 的 iframe src（window.location.origin + "/mcp-connector/ui/"）',
                    '  // 这两处都用绝对路径且不带 Ingress 前缀，在反代根路径下会 404/403。',
                    '  // 拦截方式分两层：',
                    '  //   - HTMLScriptElement/HTMLIFrameElement 的 src setter（原生 .src = 赋值）',
                    '  //   - Element.setAttribute 的 src 属性（React/JSX 创建元素走 setAttribute，不触发 src setter）',
                    '  function hookDynamicSrc(tagName) {',
                    '    var desc = Object.getOwnPropertyDescriptor(window[tagName].prototype, "src");',
                    '    if (!desc || !desc.set) return;',
                    '    Object.defineProperty(window[tagName].prototype, "src", {',
                    '      configurable: true,',
                    '      enumerable: desc.enumerable,',
                    '      get: desc.get,',
                    '      set: function(v) {',
                    '        var rewritten = rewrite(v);',
                    '        if (rewritten && rewritten !== v) {',
                    '          try { console.log("[ingress] " + tagName + " REWRITE:", v, "->", rewritten); } catch(e){}',
                    '          return desc.set.call(this, rewritten);',
                    '        }',
                    '        return desc.set.call(this, v);',
                    '      }',
                    '    });',
                    '  }',
                    '  hookDynamicSrc("HTMLScriptElement");',
                    '  hookDynamicSrc("HTMLIFrameElement");',
                    '  // 额外拦截 Element.setAttribute，覆盖 React/JSX 创建的 <iframe src=...>（不走 src setter）',
                    '  var origSetAttribute = Element.prototype.setAttribute;',
                    '  Element.prototype.setAttribute = function(name, value) {',
                    '    if (name === "src" && value && typeof value === "string" && value.indexOf("://") > 0) {',
                    '      var rewritten = rewrite(value);',
                    '      if (rewritten && rewritten !== value) {',
                    '        try { console.log("[ingress] setAttribute REWRITE:", value, "->", rewritten); } catch(e){}',
                    '        value = rewritten;',
                    '      }',
                    '    }',
                    '    return origSetAttribute.call(this, name, value);',
                    '  };',
                    '})();',
                    '</script>'
                ].join('\n');

                // ===== 核心修复：让 DSH 客户端认为运行在 loopback 环境 =====
                // DSH 通过检查 location.hostname 判断是否为回环地址：
                //   - 是回环地址 → isLoopback = true → 持久化到后端（可保存）
                //   - 非回环地址 → isLoopback = false → 仅存内存（刷新丢失）
                // HA Ingress 的 hostname 是外部反代域名，不是回环地址
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

                // ===== 一键更新功能（注入到 DSH 设置页面）=====
                // 在 DSH 设置页面底部添加版本信息和更新按钮。
                // 使用 MutationObserver 监听设置页面的 DOM 变化，找到设置内容区域后注入。
                // 注意：不使用固定定位（position:fixed），避免遮挡界面。

                const baseTag = '<base href="' + baseHref + '">\n';
                body = body.replace('<head>', '<head>' + baseTag + loopbackFixScript + cryptoPolyfillScript + ingressRewriteScript );

                const headers = cleanHeaders(proxyRes.headers);
                headers['content-length'] = Buffer.byteLength(body, 'utf-8');
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
                log('[HTTP-' + reqId + ']', 'HTML rewritten with base:', baseHref);
            });
        } else if ((pathOnly === '/api/host.describe' || pathOnly === '/api/host.listDirectory') && contentType.includes('json')) {
            // 拦截 host.describe / host.listDirectory，统一改写：
            // - hostname 改为 127.0.0.1（DSH 据此判断 isLoopback，用于持久化设置）
            // - home 改为 /data/dsh（文件浏览器/新建工作区的默认根目录，
            //   容器内 homedir() 返回 /root，导致前端主目录误显示为 /root）
            // DSH 在 HA Ingress 下返回的 hostname 是外部域名、home 是容器内 /root，这里统一改写。
            // isDirectoryPickerRequest: 记录当前是否为目录选择器，其响应含 entries/crumb。
            let body = '';
            proxyRes.on('data', (chunk) => { body += chunk.toString(); });
            proxyRes.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    let patched = [];
                    // 递归修改 hostname 和 home 字段
                    (function patchHostDescribe(obj) {
                        if (obj && typeof obj === 'object') {
                            for (const key of Object.keys(obj)) {
                                if (key === 'hostname' && typeof obj[key] === 'string') {
                                    obj[key] = '127.0.0.1';
                                    patched.push('hostname');
                                } else if (key === 'home' && typeof obj[key] === 'string') {
                                    obj[key] = '/data/dsh';
                                    patched.push('home');
                                } else {
                                    patchHostDescribe(obj[key]);
                                }
                            }
                        }
                    })(data);
                    body = JSON.stringify(data);
                    if (patched.length > 0) {
                        log('[HTTP-' + reqId + ']', 'host.' + (pathOnly === '/api/host.describe' ? 'describe' : 'listDirectory') +
                            ' patched: ' + patched.join(', ') + ' -> 127.0.0.1, /data/dsh');
                    } else {
                        log('[HTTP-' + reqId + ']', 'WARNING: host.' + (pathOnly === '/api/host.describe' ? 'describe' : 'listDirectory') +
                            ' response had no fields to patch. DSH may have changed the response structure upstream.');
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
            // 覆盖 Origin 头部为 DSH 实际地址，否则浏览器发送的 Origin: https://<外部反代域名>
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