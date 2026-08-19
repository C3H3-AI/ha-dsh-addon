#!/bin/bash

set -e

# ============================================================
# DeepSeek Harness HA Addon - 启动脚本
# 不使用 bashio（避免 s6-overlay-suexec PID 1 限制）
# 直接从 /data/options.json 读取配置
# ============================================================

CONFIG_PATH=/data/options.json

# 读取配置：优先从 /data/options.json 读取，否则从环境变量读取
# HA Supervisor 挂载 options.json 时可能因 bind mount 问题显示为目录
# 添加 fallback 机制确保启动稳定
if [ -f "${CONFIG_PATH}" ]; then
    API_KEY=$(jq -r '.api_key // ""' "${CONFIG_PATH}")
    MODEL=$(jq -r '.model // "deepseek-v4-flash"' "${CONFIG_PATH}")
    PROVIDER=$(jq -r '.provider // "deepseek-official"' "${CONFIG_PATH}")
    BASE_URL=$(jq -r '.base_url // ""' "${CONFIG_PATH}")
    WORKSPACE=$(jq -r '.workspace // ""' "${CONFIG_PATH}")
    PRESET=$(jq -r '.preset // "standard"' "${CONFIG_PATH}")
    AUTO_START=$(jq -r '.auto_start // true' "${CONFIG_PATH}")
    API_PORT=$(jq -r '.api_port // 3082' "${CONFIG_PATH}")
    HA_MCP_ENABLED=$(jq -r '.ha_mcp_enabled // false' "${CONFIG_PATH}")
    HA_MCP_URL=$(jq -r '.ha_mcp_url // ""' "${CONFIG_PATH}")
    HA_MCP_TOKEN=$(jq -r '.ha_mcp_token // ""' "${CONFIG_PATH}")
elif [ -n "${HASSIO_OPTIONS}" ]; then
    API_KEY=$(echo "${HASSIO_OPTIONS}" | jq -r '.api_key // ""')
    MODEL=$(echo "${HASSIO_OPTIONS}" | jq -r '.model // "deepseek-v4-flash"')
    PROVIDER=$(echo "${HASSIO_OPTIONS}" | jq -r '.provider // "deepseek-official"')
    BASE_URL=$(echo "${HASSIO_OPTIONS}" | jq -r '.base_url // ""')
    WORKSPACE=$(echo "${HASSIO_OPTIONS}" | jq -r '.workspace // ""')
    PRESET=$(echo "${HASSIO_OPTIONS}" | jq -r '.preset // "standard"')
    AUTO_START=$(echo "${HASSIO_OPTIONS}" | jq -r '.auto_start // true')
    API_PORT=$(echo "${HASSIO_OPTIONS}" | jq -r '.api_port // 3082')
    HA_MCP_ENABLED=$(echo "${HASSIO_OPTIONS}" | jq -r '.ha_mcp_enabled // false')
    HA_MCP_URL=$(echo "${HASSIO_OPTIONS}" | jq -r '.ha_mcp_url // ""')
    HA_MCP_TOKEN=$(echo "${HASSIO_OPTIONS}" | jq -r '.ha_mcp_token // ""')
else
    echo "[DSH Addon] WARNING: No config file found, using defaults"
    API_KEY=""
    MODEL="deepseek-v4-flash"
    PROVIDER="deepseek-official"
    BASE_URL=""
    WORKSPACE=""
    PRESET="standard"
    AUTO_START="true"
    API_PORT="3082"
    HA_MCP_ENABLED="false"
    HA_MCP_URL=""
    HA_MCP_TOKEN=""
fi

echo "[DSH Addon] Starting DeepSeek Harness Addon..."
echo "[DSH Addon]   Model: ${MODEL}"
echo "[DSH Addon]   Provider: ${PROVIDER}"
echo "[DSH Addon]   Preset: ${PRESET}"
echo "[DSH Addon]   Bridge API port: ${API_PORT}"

# 导出环境变量供 DSH 使用
export DEEPSEEK_API_KEY="${API_KEY}"
export DSH_HOME="/root/.dsh"
export DSH_API_PORT="${API_PORT}"
DSH_BIN="/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
export DSH_BIN

# 注意：--expose-internals 不能在 NODE_OPTIONS 中设置，必须作为命令行参数传递
# 找到 dsh 的实际路径并用 node 直接调用

# 如果配置了 base_url，设置模型端点
if [ -n "${BASE_URL}" ]; then
    export DEEPSEEK_BASE_URL="${BASE_URL}"
    echo "[DSH Addon]   Base URL: ${BASE_URL}"
fi

# 设置工作区：优先使用配置的工作区，否则默认为 /config
if [ -n "${WORKSPACE}" ]; then
    export DSH_WORKSPACE="${WORKSPACE}"
    echo "[DSH Addon]   Workspace: ${WORKSPACE}"
else
    export DSH_WORKSPACE="/config"
    echo "[DSH Addon]   Workspace: /config (HA 配置目录)"
fi

# 创建 DSH 数据目录
mkdir -p "${DSH_HOME}"

# 写入 DSH 配置文件（模型提供商配置）
DSH_CONFIG="${DSH_HOME}/settings.yaml"
if [ ! -f "${DSH_CONFIG}" ]; then
    echo "[DSH Addon] Creating initial DSH configuration..."
    cat > "${DSH_CONFIG}" << EOCONFIG
models:
  default: "${PROVIDER}"
providers:
  "${PROVIDER}":
    apiKey: "${API_KEY}"
    model: "${MODEL}"
EOCONFIG
fi

# ===== A 底座：可选接入 HA 原生 MCP Server（让 DSH 控设备）=====
# DSH 的 MCP 客户端配置通过 cordis 的 patch overlay 注入（--patch 参数），
# 不改动 DSH 自带 cordis.yml，避免破坏默认插件栈。
MCP_PATCH=""
if [ "${HA_MCP_ENABLED}" = "true" ] && [ -n "${HA_MCP_URL}" ]; then
    echo "[DSH Addon] HA MCP enabled -> writing cordis patch..."
    cat > /config/dsh-mcp-patch.yml << EOMCP
plugins:
  mcp-client-ha:
    transport: streamable-http
    serverName: ha
    url: "${HA_MCP_URL}"
    headers:
      Authorization: "Bearer ${HA_MCP_TOKEN}"
    toolCallTimeoutMs: 120000
    failOnStartupError: false
EOMCP
    MCP_PATCH="--patch /config/dsh-mcp-patch.yml"
    echo "[DSH Addon]   MCP patch: ${MCP_PATCH}"
else
    echo "[DSH Addon] HA MCP disabled (set ha_mcp_enabled=true + ha_mcp_url to enable)"
fi

# ===== 检查 DSH 版本（仅显示，不自动更新）=====
# 注意：npm update -g 会破坏 DSH 包，导致容器循环重启
# 上游更新后需要重新构建 Docker 镜像来更新 DSH
echo "[DSH Addon] DSH version: $(node -e "console.log(require('${DSH_BIN%bin.js}../package.json').version || 'unknown')" 2>/dev/null || echo 'unknown')"

# 注意：DSH 安全限制，不允许绑定 0.0.0.0（安全原因：会暴露远程代码执行到网络）
# 因此策略是：DSH 监听 127.0.0.1:3081，再启动 Node.js TCP 代理监听 0.0.0.0:3080 转发到 127.0.0.1:3081
# 重要：DSH 和代理必须使用不同端口，因为 0.0.0.0:3080 包含 127.0.0.1，直接绑定会冲突（EADDRINUSE）
echo "[DSH Addon] Starting DeepSeek Harness Web UI on 127.0.0.1:3081..."
cd "${DSH_WORKSPACE}" || true

# 注意：dsh 的 HMR 插件需要 --expose-internals 标志，必须通过 node 命令行参数传递
# 直接使用 dsh 包的入口文件（避免 .bin 目录 symlink 问题）
# 若启用 HA MCP，则通过 --patch 注入 mcp-client 插件
node --expose-internals "${DSH_BIN}" --profile web --host 127.0.0.1 --port 3081 ${MCP_PATCH} &
DSH_PID=$!

# 等待 DSH Web UI 就绪
echo "[DSH Addon] Waiting for DSH Web UI to be ready..."
for i in $(seq 1 30); do
    if wget -qO- http://127.0.0.1:3081 > /dev/null 2>&1; then
        echo "[DSH Addon] DSH Web UI is ready on 127.0.0.1:3081"
        break
    fi
    sleep 2
done

# 启动 HTTP 代理（0.0.0.0:3080 -> 127.0.0.1:3081）
# 便于 HA Ingress 和外部端口访问
# 与 TCP 代理不同，HTTP 代理能检测 X-Ingress-Path 头部并注入 <base> 标签
# 解决 SPA 绝对路径在 HA Ingress 下无法加载 JS/CSS 的问题
# 代理代码写入单独文件，避免 inline node -e 的 shell 引号转义问题
echo "[DSH Addon] Starting HTTP proxy on 0.0.0.0:3080 -> 127.0.0.1:3081..."
cat > /tmp/proxy.js << 'NODESCRIPT'
const http = require('http');
const net = require('net');

const DSH_PORT = 3081;
const PROXY_PORT = 3080;

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

    // 重要：去除 Ingress 前缀，否则 API 路径包含前缀会导致 DSH 返回 404
    let targetPath = req.url;
    if (ingressPath && targetPath.startsWith(ingressPath)) {
        targetPath = targetPath.slice(ingressPath.length);
        if (targetPath === '') {
            targetPath = '/';
        }
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

        if (isHtml && ingressPath) {
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
                // 注入移动端响应式样式 + 脚本
                // 核心思路：三栏布局变为上下滚动布局，弹窗/对话框覆盖全屏
                const mobileCss = [
                    '<style>',
                    '@media (max-width: 768px) {',
                    // 侧边栏：从左侧滑入的浮动面板
                    '  div[class*="sidebarCol"] {',
                    '    position: fixed !important;',
                    '    left: 0 !important;',
                    '    top: 0 !important;',
                    '    z-index: 1000 !important;',
                    '    height: 100% !important;',
                    '    width: 280px !important;',
                    '    transform: translateX(-100%) !important;',
                    '    transition: transform 0.25s ease !important;',
                    '    box-shadow: 2px 0 12px rgba(0,0,0,0.3) !important;',
                    '  }',
                    '  div[class*="sidebarCol"][data-mobile-open="true"] {',
                    '    transform: translateX(0) !important;',
                    '  }',
                    // 侧边栏打开时的遮罩层
                    '  #dsh-mobile-mask {',
                    '    position: fixed !important;',
                    '    inset: 0 !important;',
                    '    z-index: 999 !important;',
                    '    background: rgba(0,0,0,0.4) !important;',
                    '    display: none !important;',
                    '  }',
                    '  #dsh-mobile-mask[data-visible="true"] {',
                    '    display: block !important;',
                    '  }',
                    // 主内容区：全宽
                    '  div[class*="centerCol"] {',
                    '    margin-left: 0 !important;',
                    '    width: 100% !important;',
                    '    min-width: 0 !important;',
                    '  }',
                    // 右侧详情面板：全屏浮动弹窗
                    '  div[class*="detailsCol"] {',
                    '    position: fixed !important;',
                    '    left: 0 !important;',
                    '    top: 0 !important;',
                    '    z-index: 1100 !important;',
                    '    width: 100% !important;',
                    '    height: 100% !important;',
                    '    max-width: 100% !important;',
                    '    transform: translateX(100%) !important;',
                    '    transition: transform 0.25s ease !important;',
                    '    box-shadow: -2px 0 12px rgba(0,0,0,0.3) !important;',
                    '    overflow-y: auto !important;',
                    '    -webkit-overflow-scrolling: touch !important;',
                    '  }',
                    '  div[class*="detailsCol"][data-mobile-open="true"] {',
                    '    transform: translateX(0) !important;',
                    '  }',
                    // 详情面板关闭按钮
                    '  #dsh-details-close {',
                    '    position: fixed !important;',
                    '    top: 8px !important;',
                    '    right: 8px !important;',
                    '    z-index: 1101 !important;',
                    '    width: 36px !important;',
                    '    height: 36px !important;',
                    '    border: none !important;',
                    '    border-radius: 8px !important;',
                    '    background: var(--bg-surface, #2b2d31) !important;',
                    '    color: var(--fg-default, #fff) !important;',
                    '    font-size: 20px !important;',
                    '    cursor: pointer !important;',
                    '    display: none !important;',
                    '    align-items: center !important;',
                    '    justify-content: center !important;',
                    '    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;',
                    '  }',
                    '  #dsh-details-close[data-visible="true"] {',
                    '    display: flex !important;',
                    '  }',
                    // 汉堡菜单按钮
                    '  #dsh-mobile-toggle {',
                    '    position: fixed !important;',
                    '    left: 8px !important;',
                    '    top: 8px !important;',
                    '    z-index: 1001 !important;',
                    '    width: 36px !important;',
                    '    height: 36px !important;',
                    '    border: none !important;',
                    '    border-radius: 8px !important;',
                    '    background: var(--bg-surface, #2b2d31) !important;',
                    '    color: var(--fg-default, #fff) !important;',
                    '    font-size: 18px !important;',
                    '    cursor: pointer !important;',
                    '    display: flex !important;',
                    '    align-items: center !important;',
                    '    justify-content: center !important;',
                    '    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;',
                    '  }',
                    // 通用弹窗/对话框：全屏覆盖
                    '  div[class*="dialog"], div[role="dialog"], div[class*="modal"] {',
                    '    position: fixed !important;',
                    '    left: 0 !important;',
                    '    top: 0 !important;',
                    '    z-index: 1200 !important;',
                    '    width: 100% !important;',
                    '    height: 100% !important;',
                    '    max-width: 100% !important;',
                    '    max-height: 100% !important;',
                    '    margin: 0 !important;',
                    '    border-radius: 0 !important;',
                    '    overflow-y: auto !important;',
                    '    -webkit-overflow-scrolling: touch !important;',
                    '  }',
                    '  div[class*="dialog"] > :first-child,',
                    '  div[role="dialog"] > :first-child {',
                    '    max-width: 100% !important;',
                    '    width: 100% !important;',
                    '    margin: 0 !important;',
                    '    border-radius: 0 !important;',
                    '    height: 100% !important;',
                    '  }',
                    // 底部安全区域
                    '  body {',
                    '    padding-bottom: env(safe-area-inset-bottom, 0px) !important;',
                    '  }',
                    '}',
                    '</style>'
                ].join('\n');

                // 移动端交互脚本
                // 使用 MutationObserver 等待 SPA 渲染完成后操作 DOM
                // 功能：侧边栏滑动切换、详情面板全屏展示、弹窗适配
                const mobileToggleScript = [
                    '<script>',
                    '(function(){',
                    '  if (window.innerWidth > 768) return;',
                    '  var M_OBSERVER = new MutationObserver(function() {',
                    "    var frame = document.querySelector('[class*=\"frame\"]');",
                    "    var sidebar = document.querySelector('[class*=\"sidebarCol\"]');",
                    "    var details = document.querySelector('[class*=\"detailsCol\"]');",
                    "    var center = document.querySelector('[class*=\"centerCol\"]');",
                    '    if (!frame || !sidebar) return;',
                    '    M_OBSERVER.disconnect();',
                    // 设置网格布局：侧边栏宽度固定为 0，由 CSS 控制
                    '    var origGrid = frame.style.gridTemplateColumns || "";',
                    '    var parts = origGrid.split(/\\s+/);',
                    '    if (parts.length >= 3) {',
                    '      parts[0] = "0px";',
                    '      parts[2] = "0px";',
                    '      frame.style.gridTemplateColumns = parts.join(" ");',
                    '    }',
                    // 侧边栏由 CSS 控制，只需设置 data 属性
                    // 创建遮罩层
                    "    var mask = document.createElement('div');",
                    '    mask.id = "dsh-mobile-mask";',
                    '    mask.onclick = function() {',
                    '      sidebar.dataset.mobileOpen = "false";',
                    '      mask.dataset.visible = "false";',
                    '    };',
                    '    document.body.appendChild(mask);',
                    // 汉堡菜单按钮
                    "    var btn = document.createElement('button');",
                    '    btn.id = "dsh-mobile-toggle";',
                    '    btn.textContent = "☰";',
                    '    btn.onclick = function() {',
                    '      var isOpen = sidebar.dataset.mobileOpen === "true";',
                    '      sidebar.dataset.mobileOpen = isOpen ? "false" : "true";',
                    '      mask.dataset.visible = isOpen ? "false" : "true";',
                    '    };',
                    '    document.body.appendChild(btn);',
                    // 详情面板全屏适配
                    '    if (details) {',
                    '      details.dataset.mobileOpen = "false";',
                    // 监听详情面板的 style.display 变化（DSH 控制显示/隐藏）
                    "      var detailsObserver = new MutationObserver(function() {",
                    '        var d = details.style.display;',
                    '        if (d && d !== "none") {',
                    '          details.dataset.mobileOpen = "true";',
                    '          closeBtn.dataset.visible = "true";',
                    '          center.style.display = "none";',
                    '        } else {',
                    '          details.dataset.mobileOpen = "false";',
                    '          closeBtn.dataset.visible = "false";',
                    '          center.style.display = "";',
                    '        }',
                    '      });',
                    "      detailsObserver.observe(details, { attributes: true, attributeFilter: ['style'] });",
                    // 详情面板关闭按钮
                    "      var closeBtn = document.createElement('button');",
                    '      closeBtn.id = "dsh-details-close";',
                    '      closeBtn.textContent = "✕";',
                    '      closeBtn.dataset.visible = "false";',
                    '      closeBtn.onclick = function() {',
                    '        details.style.display = "none";',
                    '        details.dataset.mobileOpen = "false";',
                    '        closeBtn.dataset.visible = "false";',
                    '        center.style.display = "";',
                    '      };',
                    '      document.body.appendChild(closeBtn);',
                    '    }',
                    '  });',
                    '  M_OBSERVER.observe(document.body, { childList: true, subtree: true });',
                    "  setTimeout(function() { M_OBSERVER.disconnect(); }, 15000);",
                    '})();',
                    '</script>'
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
                    '    var path = typeof url === "string" ? url : (url && url.pathname) || "";',
                    '    if (path.startsWith("/api/")) {',
                    '      return ORIGIN + BASE + path + (url.search || "");',
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

                const baseTag = '<base href="' + baseHref + '">\n';
                body = body.replace('<head>', '<head>' + mobileCss + baseTag + loopbackFixScript + cryptoPolyfillScript + mobileToggleScript + ingressFixScript);

                const headers = cleanHeaders(proxyRes.headers);
                headers['content-length'] = Buffer.byteLength(body, 'utf-8');
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
                log('[HTTP-' + reqId + ']', 'HTML rewritten with base:', baseHref);
            });
        } else if (targetPath === '/api/host.describe' && contentType.includes('json')) {
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
                    // 递归修改所有 hostname 字段
                    (function patchHostname(obj) {
                        if (obj && typeof obj === 'object') {
                            for (const key of Object.keys(obj)) {
                                if (key === 'hostname' && typeof obj[key] === 'string') {
                                    obj[key] = '127.0.0.1';
                                } else {
                                    patchHostname(obj[key]);
                                }
                            }
                        }
                    })(data);
                    body = JSON.stringify(data);
                    log('[HTTP-' + reqId + ']', 'host.describe patched: hostname -> 127.0.0.1');
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
NODESCRIPT

node /tmp/proxy.js &
PROXY_PID=$!

# ===== 启动桥接 API（deepseek_harness 集成依赖此稳定契约）=====
echo "[DSH Addon] Starting bridge API on 0.0.0.0:${API_PORT}..."
node /api_server.js &
API_PID=$!

# 等待 DSH 进程结束
wait ${DSH_PID}
# 如果 DSH 退出，也停止代理与桥接 API
kill ${PROXY_PID} 2>/dev/null || true
kill ${API_PID} 2>/dev/null || true
