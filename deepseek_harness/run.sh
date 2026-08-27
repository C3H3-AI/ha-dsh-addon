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
    API_TOKEN=$(jq -r '.api_token // ""' "${CONFIG_PATH}")
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
    API_TOKEN=$(echo "${HASSIO_OPTIONS}" | jq -r '.api_token // ""')
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
    API_TOKEN=""
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
if [ -n "${API_TOKEN}" ]; then
    echo "[DSH Addon]   Bridge API auth: enabled (api_token set)"
else
    echo "[DSH Addon]   Bridge API auth: DISABLED - 写操作将返回 401（请设置 api_token）"
fi

# 导出环境变量供 DSH 使用
export DEEPSEEK_API_KEY="${API_KEY}"
# 桥接 API 共享密钥（集成侧需填相同值）
export DSH_API_TOKEN="${API_TOKEN}"
# 重要：DSH_HOME 必须指向持久化目录！
# HA Supervisor 为每个 addon 提供持久化的 /data 目录（容器重建后不丢失），
# 而 /root/.dsh 是容器内普通目录，addon 重建/重启后会被清空。
# 会话日志（$DSH_HOME/sessions/*.jsonl.zstd）、设置（settings.yaml）、
# 凭据（.credentials.yaml）等全部数据都存储在 $DSH_HOME 下，
# 若指向非持久化目录则对话记录和设置会在重启后全部丢失。
export DSH_HOME="/data/dsh"
export DSH_API_PORT="${API_PORT}"

# ===== DSH 运行路径解析：一键更新(vendor) 优先，否则镜像内置 =====
# Web 一键更新（DESIGN.md §9）会把新版 DSH 装到 /data/dsh/vendor（持久化），
# 因此容器每次启动都要优先加载 vendor 里的新版，镜像内置版仅作离线兜底。
VENDOR_DIR="/data/dsh/vendor"
VENDOR_DSH_BIN="${VENDOR_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ -f "${VENDOR_DSH_BIN}" ]; then
    # 验证 vendor DSH 完整性：package.json 可解析 + 全部运行时依赖可解析。
    # 曾出现 vendor 装包不全导致 "Cannot find package '@deepseek-ai/cordis-plugin-group'"
    # DSH 启动失败并进入 stopped 状态，因此损坏时必须自动回退内置版（DESIGN.md §9.6 风险表）。
    if node -e "
        const fs = require('fs');
        const path = require('path');
        const base = '${VENDOR_DIR}/node_modules';
        const pkgPath = path.join(base, '@deepseek-ai/dsh/package.json');
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          const deps = Object.keys(pkg.dependencies || {}).filter(
            d => !(pkg.optionalDependencies || {})[d]
          );
          for (const d of deps) {
            try { require.resolve(d, { paths: [base, path.dirname(pkgPath)] }); }
            catch (e) { console.error('missing dep: ' + d); process.exit(1); }
          }
          console.log('vendor DSH integrity OK (deps: ' + deps.length + ')');
        } catch (e) {
          console.error('vendor DSH invalid: ' + e.message);
          process.exit(1);
        }
    "; then
        DSH_BIN="${VENDOR_DSH_BIN}"
        echo "[DSH Addon] Using vendor DSH (one-click updated): ${DSH_BIN}"
        if [ -f "${VENDOR_DIR}/.updated" ]; then
            echo "[DSH Addon] Update marker: $(cat "${VENDOR_DIR}/.updated")"
        fi
    else
        echo "[DSH Addon] ERROR: vendor DSH corrupted (missing deps) - removing and falling back to built-in"
        rm -rf "${VENDOR_DIR}"
        DSH_BIN="/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
        echo "[DSH Addon] Using built-in DSH: ${DSH_BIN}"
    fi
else
    DSH_BIN="/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
    echo "[DSH Addon] Using built-in DSH: ${DSH_BIN}"
fi
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
    export DSH_WORKSPACE="/data/dsh/workspace"
    echo "[DSH Addon]   Workspace: /data/dsh/workspace (DSH 工作区)"
fi

# 设置 HOME=/data/dsh：node os.homedir() 读取 HOME 环境变量。
# 容器默认 HOME=/root，导致 DSH 的"主目录"（host.describe.home、
# host.listDirectory 默认路径、新建工作区默认文件夹）全部指向 /root，
# 且 /root 在容器重建后丢失数据。统一指向持久化的 /data/dsh。
export HOME="/data/dsh"

# 创建 DSH 数据目录
mkdir -p "${DSH_HOME}"
# 确保工作区目录存在（run.sh 后续会 cd 到 DSH_WORKSPACE 再启动 DSH，
# 目录不存在会导致 cd 静默失败、DSH 从容器根目录启动，主工作区落在 / root 下）
mkdir -p "${DSH_WORKSPACE}"

# ===== 清理 DSH 运行时锁文件（异常退出后残留，导致启动失败）=====
# task-board 的 ledger lock 在 DSH 异常退出后不会自动清理，
# 下次启动时报 "task-board ledger is already owned by process XXX"。
# 直接删除所有 lock 文件，DSH 正常启动时会重新创建。
find "${DSH_HOME}" \( -name '*.lock' -o -name 'ledger-v2.lock' \) 2>/dev/null | while read lockfile; do
    echo "[DSH Addon]   Cleaning stale lock: ${lockfile}"
    rm -f "${lockfile}"
done

# ===== 数据持久化自检探针（轻量级诊断，不执行任何恢复动作）=====
# 目的：addon 更新/重启后，运维可从启动日志直接确认数据是否完好，
# 避免"会话/设置丢失"只能等用户报告才发现（DESIGN.md §4）。
# 只读检查 + 日志输出，不做任何写操作或自动恢复。
DATA_PROBE_FAIL=0

# 1. 数据目录存在性与可写性
if [ ! -d "${DSH_HOME}" ] || [ ! -w "${DSH_HOME}" ]; then
    echo "[DSH Addon] ERROR: DSH_HOME (${DSH_HOME}) missing or not writable - 数据持久化将失败！"
    DATA_PROBE_FAIL=1
fi

# 2. 会话数据存在性（只读统计，供重启前后对比）
if [ -d "${DSH_HOME}/sessions" ]; then
    SESSION_COUNT=$(find "${DSH_HOME}/sessions" -name '*.jsonl.zstd' 2>/dev/null | wc -l)
    echo "[DSH Addon] Data probe: sessions dir exists, ${SESSION_COUNT} session file(s)"
    if [ "${SESSION_COUNT}" -eq 0 ]; then
        echo "[DSH Addon] WARNING: sessions dir is empty - 若非首次启动，历史会话可能已丢失（见 DESIGN.md §4）"
    fi
else
    echo "[DSH Addon] INFO: sessions dir not present (expected on first start)"
fi

# 3. 设置文件存在性
if [ -f "${DSH_HOME}/settings.yaml" ]; then
    echo "[DSH Addon] Data probe: settings.yaml present"
else
    echo "[DSH Addon] INFO: settings.yaml not present (will be generated below)"
fi

# 4. 工作区元数据（storages/）存在性
if [ -d "${DSH_HOME}/storages" ]; then
    echo "[DSH Addon] Data probe: storages/ (workspace metadata) present"
else
    echo "[DSH Addon] INFO: storages/ not present (expected on first start)"
fi

# 数据目录不可用属于致命错误：/data 不可写则一切数据无法持久化，
# 立即退出让 Supervisor 标记失败，避免"看似正常运行实则数据全丢"。
if [ "${DATA_PROBE_FAIL}" -eq 1 ]; then
    echo "[DSH Addon] FATAL: /data persistence unavailable - aborting to avoid data loss"
    exit 1
fi

# ===== 部署 HA 自定义集成到 /config/custom_components/ =====
# 镜像内 /custom_components/deepseek_harness/ 由 Dockerfile 打包，
# 每次启动时复制到 HA Core 的配置目录，使 HA 能加载该集成。
# 先清空目标目录避免旧文件残留，再完整复制。
# 注意：/config 是 HA Supervisor 共享卷，addon 有 rw 权限（map: config:rw）。
CC_SRC="/custom_components/deepseek_harness"
CC_DST="/config/custom_components/deepseek_harness"
if [ -d "${CC_SRC}" ]; then
    echo "[DSH Addon] Deploying custom_components/deepseek_harness to HA..."
    rm -rf "${CC_DST}"
    mkdir -p "$(dirname "${CC_DST}")"
    cp -a "${CC_SRC}" "${CC_DST}"
    echo "[DSH Addon]   Deployed: $(find "${CC_DST}" -type f | wc -l) files"
    # 清理 __pycache__ 防止 HA 加载缓存旧代码
    find "${CC_DST}" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
    echo "[DSH Addon]   Custom component deployed to ${CC_DST}"
else
    echo "[DSH Addon] WARNING: /custom_components not found in container (old image?) - skipping deployment"
fi

# 写入 DSH 配置文件（模型提供商配置）
# 策略：已存在時 merge 只更新 provider 配置，不碰 DSH UI 產生的設定（locale/onboarding/pet 等）；
# 不存在時從頭創建。
# 這樣用戶在 HA 配置頁面修改 api_key/model/provider/base_url 後重啟即生效，
# 無需手動刪除 settings.yaml。
DSH_CONFIG="${DSH_HOME}/settings.yaml"
if [ -f "${DSH_CONFIG}" ]; then
    echo "[DSH Addon] Merging provider config into existing settings.yaml..."
    # 导出供 node 内嵌脚本读取（settings.yaml merge）
    export HA_PROVIDER="${PROVIDER}"
    export HA_MODEL="${MODEL}"
    export HA_API_KEY="${API_KEY}"
    export HA_BASE_URL="${BASE_URL}"
    node << 'NODEMERGE'
const fs = require('fs');
const path = require('path');
const yamlPath = process.env.DSH_CONFIG || '/data/dsh/settings.yaml';
const provider = process.env.HA_PROVIDER || 'deepseek-official';
const model = process.env.HA_MODEL || 'deepseek-v4-flash';
const apiKey = process.env.HA_API_KEY || '';
const baseUrl = process.env.HA_BASE_URL || '';
// 嘗試從 dshmarket 加載 js-yaml
let yaml;
try {
  yaml = require('/data/dsh/profiles/web/node_modules/dshmarket/node_modules/js-yaml');
} catch {
  console.log('[DSH Addon]   js-yaml not available, falling back to text merge');
  yaml = null;
}
if (yaml) {
  // YAML 模式：完全解析，只改 providers 和 models.default
  try {
    const doc = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
    if (!doc) throw new Error('empty YAML');
    doc.models = doc.models || {};
    doc.models.default = provider;
    doc.providers = doc.providers || {};
    doc.providers[provider] = doc.providers[provider] || {};
    doc.providers[provider].apiKey = apiKey;
    doc.providers[provider].model = model;
    if (baseUrl) doc.providers[provider].baseUrl = baseUrl;
    else delete doc.providers[provider].baseUrl;
    fs.writeFileSync(yamlPath, yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"', forceQuotes: true }));
    console.log('[DSH Addon]   settings.yaml merged (yaml mode)');
  } catch (e) {
    console.log('[DSH Addon]   yaml merge failed: ' + e.message + ', falling back to text merge');
    yaml = null;
  }
}
if (!yaml) {
  // 文本回退模式：行級替換，不碰非 provider 行
  let content = fs.readFileSync(yamlPath, 'utf8');
  let lines = content.split('\n');
  let inModels = false;
  let inProviders = false;
  let currentProvider = null;
  let providerDone = false;
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 追蹤頂層區塊進入/退出
    if (/^[a-z]/.test(line) && /^\S/.test(line)) {
      inModels = /^models:/.test(line);
    }
    // 替換 models.default（只在 models 區塊內生效）
    if (/^\s*default:/.test(line) && inModels) {
      result.push('  default: "' + provider + '"');
      continue;
    }
    // 追蹤 providers: 區塊
    if (/^providers:/.test(line)) {
      inProviders = true;
      result.push(line);
      continue;
    }
    if (inProviders) {
      // 遇到非縮進行（新頂層 key）時退出 providers
      if (!/^\s/.test(line) && line.trim() !== '') {
        if (!providerDone) {
          // 在 providers 塊末尾插入當前 provider
          result.push('  "' + provider + '":');
          result.push('    apiKey: "' + apiKey + '"');
          result.push('    model: "' + model + '"');
          if (baseUrl) result.push('    baseUrl: "' + baseUrl + '"');
          providerDone = true;
        }
        inProviders = false;
        result.push(line);
        continue;
      }
      // providers 內，匹配 provider key
      const pm = line.match(/^\s+"([^"]+)":/);
      if (pm) {
        // 輸出前一個 provider 的內容（跳過已處理的）
        if (currentProvider === provider) {
          // 跳過已處理的 provider 的 key/apiKey/model/baseUrl 行
          currentProvider = pm[1];
          continue;
        }
        currentProvider = pm[1];
        if (currentProvider === provider) {
          // 輸出這個 provider 的 key，然後跳過其子行
          result.push(line);
          providerDone = true;
          continue;
        }
        result.push(line);
        continue;
      }
      // provider 子行
      if (currentProvider === provider) {
        // 跳過 apiKey/model/baseUrl 行（已被替換）
        if (/^\s{4,}(apiKey|model|baseUrl):/.test(line)) continue;
        result.push(line);
        continue;
      }
      result.push(line);
      continue;
    }
    result.push(line);
  }
  // 如果遍歷完還沒插入 provider（文件裏沒有 providers 塊）
  if (!providerDone) {
    result.push('providers:');
    result.push('  "' + provider + '":');
    result.push('    apiKey: "' + apiKey + '"');
    result.push('    model: "' + model + '"');
    if (baseUrl) result.push('    baseUrl: "' + baseUrl + '"');
  }
  fs.writeFileSync(yamlPath, result.join('\n'));
  console.log('[DSH Addon]   settings.yaml merged (text mode)');
}
NODEMERGE
else
    echo "[DSH Addon] Creating initial DSH configuration..."
    cat > "${DSH_CONFIG}" << EOCONFIG
models:
  default: "${PROVIDER}"
providers:
  "${PROVIDER}":
    apiKey: "${API_KEY}"
    model: "${MODEL}"
    ${BASE_URL:+baseUrl: "${BASE_URL}"}
EOCONFIG
fi

# ===== A 底座：可选接入 HA 原生 MCP Server（让 DSH 控设备）=====
# DSH 0.1.0-rc.7 不支持 --patch 命令行参数，改为写入 Home 级 patch 文件
# 根据 DSH 装配规则，Home 级 patch ($DSH_HOME/cordis.patch.yml) 会自动加载在最后一层
# 这样我们可以在不修改原始 profile 的前提下注入 MCP 插件配置
if [ "${HA_MCP_ENABLED}" = "true" ] && [ -n "${HA_MCP_URL}" ]; then
    echo "[DSH Addon] HA MCP enabled -> writing Home-level cordis patch..."
    cat > "${DSH_HOME}/cordis.patch.yml" << EOMCP
# 注入 HA MCP 客户端插件（Home 级 patch，自动加载）
# DSH 装配系统要求 patch 文件为顶层 YAML 数组格式
- insert:
    - id: ha-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: ha
        url: "${HA_MCP_URL}"
        headers:
          Authorization: "Bearer ${HA_MCP_TOKEN}"
        toolCallTimeoutMs: 120000
        failOnStartupError: false
EOMCP
    echo "[DSH Addon]   MCP patch: ${DSH_HOME}/cordis.patch.yml"
else
    echo "[DSH Addon] HA MCP disabled (set ha_mcp_enabled=true + ha_mcp_url to enable)"
fi

# ===== B 底座：修复 dsh-im 插件 RPC 权威校验 =====
# dsh-im 插件默认 rpcAuthority: 'loopback'，仅允许回环 IP 请求。
# 在 HA Ingress 代理环境下，请求来源 IP 不是 127.0.0.1，导致 RPC 调用返回 404。
# 修复：在插件 bundle patch 中注入 rpcAuthority: 'trusted-host'，绕过 IP 校验。
export DSH_IM_PATCH="${DSH_HOME}/profiles/web/node_modules/@xmanrui/dsh-im/cordis.patch.yml"
if [ -f "${DSH_IM_PATCH}" ]; then
    if ! grep -q "rpcAuthority" "${DSH_IM_PATCH}" 2>/dev/null; then
        echo "[DSH Addon]   Patching dsh-im rpcAuthority -> trusted-host..."
        node << 'NODESCRIPT'
const fs = require('fs');
const path = process.env.DSH_IM_PATCH || '';
if (!path) { process.exit(0); }
try {
  let content = fs.readFileSync(path, 'utf8');
  if (!content.includes('rpcAuthority')) {
    // 使用正则匹配 name: '@xmanrui/dsh-im'（任意缩进），
    // 在 name 行下方插入 config: 行（缩进对齐name），避免字符串replace缩进不匹配。
    content = content.replace(
      /^(\s*)name: '@xmanrui\/dsh-im'$/m,
      "$1name: '@xmanrui/dsh-im'\n$1config:\n$1  rpcAuthority: trusted-host"
    );
    fs.writeFileSync(path, content);
    console.log('[DSH Addon]   dsh-im rpcAuthority patched to trusted-host');
  }
} catch (e) {
  console.log('[DSH Addon]   dsh-im patch error: ' + e.message);
}
NODESCRIPT
    else
        echo "[DSH Addon]   dsh-im rpcAuthority already set (skipped)"
    fi
else
    echo "[DSH Addon]   dsh-im plugin not found at ${DSH_IM_PATCH} - skipping rpcAuthority patch"
    echo "[DSH Addon]   This is expected if dsh-im is not installed via the DSH plugin marketplace"
fi

# ===== 检查 DSH 版本（仅显示，不自动更新）=====
# 注意：npm update -g 会破坏 DSH 包，导致容器循环重启
# 上游更新后需要重新构建 Docker 镜像来更新 DSH
echo "[DSH Addon] DSH version: $(node -e "console.log(require('${DSH_BIN%bin.js}../package.json').version || 'unknown')" 2>/dev/null || echo 'unknown')"

# ===== 预写 pnpm store-dir 到 .npmrc（必须在任何 dsh plugin 命令之前）=====
# 确保 profile 的 node_modules 从首次创建起就使用固定的持久化 store 路径，
# 避免 pnpm 默认 store 路径在容器重建后漂移，导致所有插件操作失败。
# 注意：此段必须在下面的 dsh-market 安装和 profile 完整性检查之前执行。
node << 'NODENPMRC'
const fs = require('fs');
const path = require('path');
const prof = path.join(process.env.DSH_HOME || '/data/dsh', 'profiles', 'web');
const npmrc = path.join(prof, '.npmrc');
const STORE_DIR = '/data/.pnpm-store';
// 确保 profile 目录存在（即使 profile 尚未初始化）
fs.mkdirSync(prof, { recursive: true });
// 读取或创建 .npmrc，确保 store-dir 指向固定路径
let content = '';
if (fs.existsSync(npmrc)) {
  content = fs.readFileSync(npmrc, 'utf8');
}
const storeLine = 'store-dir=' + STORE_DIR;
if (!content.includes(storeLine)) {
  content = content.replace(/^store-dir=.*$/gm, '').trim();
  content += '\n' + storeLine + '\n';
  fs.writeFileSync(npmrc, content);
  console.log('[DSH Addon]   pnpm store-dir pre-set to ' + STORE_DIR);
}
// 确保 store 目录存在
fs.mkdirSync(STORE_DIR, { recursive: true });
NODENPMRC

# ===== 检查并修复 DSH profile 完整性 =====
# 异常退出可能导致 profile 缺少关键包（如 @linxin666/dsh-web-ui-all），
# DSH 启动时报 "cannot resolve profile bundle"。用 dsh plugin 命令重新安装。
if [ -d "${DSH_HOME}/profiles/web" ]; then
    PROFILE_BUNDLE="${DSH_HOME}/profiles/web/node_modules/@linxin666/dsh-web-ui-all"
    if [ ! -d "${PROFILE_BUNDLE}" ]; then
        echo "[DSH Addon] WARNING: profile bundle @linxin666/dsh-web-ui-all missing, reinstalling..."
        node --expose-internals "${DSH_BIN}" plugin --profile web install 2>&1 || echo "[DSH Addon]   WARNING: profile reinstall failed (may be incomplete)"
    fi
fi

# ===== 默认安装 dsh-market 插件市场（https://github.com/dsh-market/dsh-market）=====
# 首次启动自动安装 DSH 官方插件市场，使用户可在 Web UI 的
# Settings → Plugin Market 浏览/搜索/一键安装社区插件。
# 仅在未安装时执行一次；无关注册表、缓存失败或网络异常时本次跳过，下次启动重试。
# 注意：minimumReleaseAge 已由 pnpm-workspace.yaml 原生配置，无需 CLI 参数。
DSH_MARKET_DIR="${DSH_HOME}/profiles/web/node_modules/dshmarket"
if [ ! -d "${DSH_MARKET_DIR}" ]; then
    echo "[DSH Addon] dsh-market not installed -> default-installing (one-time)..."
    node --expose-internals "${DSH_BIN}" plugin --profile web add dshmarket 2>&1 \
        || echo "[DSH Addon]   WARNING: dsh-market install failed (check network/registry), will retry next start"
else
    echo "[DSH Addon] dsh-market already installed (skipped)"
fi

# ===== 清理 dsh-market 孤儿热补丁（hot-*.yml）=====
# dsh-market 为 client 类插件动态生成 .dsh-market/hot-*.yml 前端补丁，
# 但卸载插件时可能不清理，残留补丁引用的模块已删除，导致前端加载报
# "Failed to load plugins: ... bundle script .../plugins/<pkg>/client.js failed to load"。
# 启动时对每个 hot 文件做"引用的顶层包是否仍存在"校验，全部不存在即为孤儿，删除。
node << 'NODECLEAN'
const fs = require('fs');
const path = require('path');
const prof = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'web') : '/data/dsh/profiles/web';
const hotDir = path.join(prof, '.dsh-market');
if (!fs.existsSync(hotDir)) process.exit(0);
const nodemods = path.join(prof, 'node_modules');
const exists = (p) => fs.existsSync(nodemods) && fs.existsSync(path.join(nodemods, p));
let kept = 0, removed = 0;
for (const file of fs.readdirSync(hotDir)) {
  if (!/^hot-.*\.yml$/.test(file)) continue;
  const full = path.join(hotDir, file);
  let content;
  try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
  const refs = new Set();
  const r1 = /plugins\/(@[^/]+\/[^/]+|[^/]+)\/client\.js/g;
  const r2 = /node_modules\/(@[^/]+\/[^/]+|[^/]+)/g;
  const r3 = new RegExp("name:\\s*['\"]?(@[a-z0-9-]+\\/[a-z0-9-]+|[a-z0-9][a-z0-9._-]*[a-z0-9])", 'g');
  let m;
  while ((m = r1.exec(content))) refs.add(m[1]);
  while ((m = r2.exec(content))) refs.add(m[1]);
  while ((m = r3.exec(content))) refs.add(m[1].replace(/['"]/g, ''));
  if (refs.size === 0) continue;
  let anyExists = false;
  for (const r of refs) { if (exists(r)) { anyExists = true; break; } }
  if (anyExists) { kept++; continue; }
  console.log('[DSH Addon]   cleanup orphan hot patch: ' + file + ' (refs: ' + Array.from(refs).join(', ') + ')');
  try { fs.unlinkSync(full); removed++; } catch {}
}
console.log('[DSH Addon] orphan hot patches: removed=' + removed + ', kept=' + kept);
NODECLEAN

# ===== 冪等補全 pnpm-workspace.yaml 策略（全新安裝也能裝 build 類插件）=====
# DSH 官方 initProfile 模板只含 packages/nodeLinker/autoInstallPeers 三行，
# 不帶 minimumReleaseAge 和 allowBuilds。pnpm 11 默認禁止 24h 內新包和構建腳本，
# 導致全新安裝時 "dsh plugin add" 裝 build 類插件（如 node-pty）必被攔。
# 每次啟動時檢查並補全，已在運行的環境（已有白名單）不受影響。
node << 'NODEWS'
const fs = require('fs');
const path = require('path');
const wsPath = path.join(process.env.DSH_HOME || '/data/dsh', 'profiles', 'web', 'pnpm-workspace.yaml');
if (!fs.existsSync(wsPath)) process.exit(0);
let content = fs.readFileSync(wsPath, 'utf8');
let changed = false;
if (!content.includes('minimumReleaseAge')) {
  content = content.replace('autoInstallPeers: false', 'autoInstallPeers: false\nminimumReleaseAge: 0');
  changed = true;
}
if (!content.includes('allowBuilds')) {
  content += '\nallowBuilds:\n  node-pty: true\n  ssh2: true\n';
  changed = true;
}
if (changed) {
  fs.writeFileSync(wsPath, content);
  console.log('[DSH Addon]   pnpm-workspace.yaml patched: minimumReleaseAge + allowBuilds');
} else {
  console.log('[DSH Addon]   pnpm-workspace.yaml already configured (skipped)');
}
NODEWS

# ===== 检查并修复 pnpm store 链接失效（环境重建后 store 被清空的情况）=====
# .npmrc 的 store-dir 已在前面 NODENPMRC 段预写，这里只做兜底恢复：
# 若 node_modules 已存在但 store 目录为空（容器重建后 /data/.pnpm-store 被清空），
# 自动 pnpm install --force 重新链接。
node << 'NODERELINK'
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const prof = path.join(process.env.DSH_HOME || '/data/dsh', 'profiles', 'web');
const STORE_DIR = '/data/.pnpm-store';
const nmDir = path.join(prof, 'node_modules');
const lockFile = path.join(nmDir, '.pnpm', 'pnpm-lock.yaml');
if (!fs.existsSync(lockFile)) { process.exit(0); }
// 检查 store 目录是否为空（容器重建后 /data/.pnpm-store 可能被清空）
let storeOk = false;
try { const pkgs = fs.readdirSync(STORE_DIR); storeOk = pkgs.length > 0; } catch { storeOk = false; }
if (!storeOk) {
  console.log('[DSH Addon]   pnpm store is empty/missing, running pnpm install --force...');
  try {
    execSync('pnpm install --force --no-frozen-lockfile', {
      cwd: prof, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      env: Object.assign({}, process.env, { PNPM_HOME: process.env.PNPM_HOME || '/data/dsh/.local/share/pnpm' })
    });
    console.log('[DSH Addon]   pnpm install --force completed (store relinked)');
  } catch (e) {
    console.log('[DSH Addon]   WARNING: pnpm relink failed: ' + (e.stderr || e.message).toString().slice(0, 300));
    console.log('[DSH Addon]   Plugins may need manual reinstall via DSH plugin market');
  }
}
NODERELINK

# 注意：DSH 安全限制，不允许绑定 0.0.0.0（安全原因：会暴露远程代码执行到网络）
# 因此策略是：DSH 监听 127.0.0.1:3081，再启动 Node.js TCP 代理监听 0.0.0.0:3080 转发到 127.0.0.1:3081
# 重要：DSH 和代理必须使用不同端口，因为 0.0.0.0:3080 包含 127.0.0.1，直接绑定会冲突（EADDRINUSE）
echo "[DSH Addon] Starting DeepSeek Harness Web UI on 127.0.0.1:3081..."
cd "${DSH_WORKSPACE}" || true

# 注意：dsh 的 HMR 插件需要 --expose-internals 标志，必须通过 node 命令行参数传递
# 直接使用 dsh 包的入口文件（避免 .bin 目录 symlink 问题）
# 若启用 HA MCP，则通过 Home 级 cordis.patch.yml 注入 mcp-client 插件
node --expose-internals "${DSH_BIN}" --profile web --host 127.0.0.1 --port 3081 &
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

# ===== 关闭 DSH 设备配对（HA Ingress 下不需要 LAN 配对）=====
# DSH rc.8 引入了 remote-web-ui 和设备配对功能，在 Ingress 环境下
# DSH 认为连接来自远程设备，要求配对才能访问工作区数据。
# 设置 requirePairingForLan=false 跳过配对检查。
echo "[DSH Addon] Disabling DSH device pairing (requirePairingForLan=false)..."
curl -s -X POST http://127.0.0.1:3081/api/settings.mutate \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"startup","method":"settings.mutate","payload":{"ns":"remote-web-ui","ops":[{"op":"set","path":[],"value":{"requirePairingForLan":false,"enabled":true}}]}}' \
  > /dev/null 2>&1 || echo "[DSH Addon]   WARNING: failed to disable device pairing (DSH may not be ready yet)"

# 启动 HTTP 代理（0.0.0.0:3080 -> 127.0.0.1:3081）
# 便于 HA Ingress 和外部端口访问
# 与 TCP 代理不同，HTTP 代理能检测 X-Ingress-Path 头部并注入 <base> 标签
# 解决 SPA 绝对路径在 HA Ingress 下无法加载 JS/CSS 的问题
# 代理代码写入单独文件，避免 inline node -e 的 shell 引号转义问题
# ===== 幂等修复 proxy.js 的 HA Ingress 兼容（重启/重建后镜像会还原 proxy.js，此段确保修复始终生效）=====
# 背景：/proxy.js 是镜像内置文件，容器重建会被还原成原始版本，导致以下问题复发：
#   - dsh-better-sidebar 的 /sidebar/bundle/*.js 懒加载 chunk 在 HA Ingress 下 404/403
#   - dsh-mcp-connector 的 iframe (/mcp-connector/ui/) 因绝对路径不带前缀而 404
#   - WebSocket (wss://) 因 origin 协议与页面 https:// 不同被误判为跨源而跳过前缀
# 修复方式：维护一份"已知正确"的 proxy.js 到持久化目录（/data/dsh/proxy.fixed.js），
# 每次启动 proxy 前，若 /proxy.js 缺失修复标记（HTMLIFrameElement hook），则用正确版本覆盖。
# 幂等：已是修复版则跳过。
node << 'NODEPROXYFIX'
const fs = require('fs');
const path = require('path');
const TARGET = '/proxy.js';
const BACKUP_DIR = '/data/dsh';
const FIXED = path.join(BACKUP_DIR, 'proxy.fixed.js');
const DSH_HOME = process.env.DSH_HOME || '/data/dsh';

function hasFix(src) {
  // 判定 proxy.js 是否已含全部修复标记
  const hasOriginFix = src.indexOf('u.origin !== ORIGIN') === -1;            // 旧的 origin 比较已移除
  const hasIframeHook = src.indexOf('HTMLIFrameElement') !== -1;             // iframe hook 存在
  const hasScriptHook = src.indexOf('HTMLScriptElement') !== -1;             // script hook 存在
  return hasOriginFix && hasIframeHook && hasScriptHook;
}

// 若持久化目录没有正确版本，尝试从当前（可能已修复的）/proxy.js 建立基准
if (!fs.existsSync(FIXED) && fs.existsSync(TARGET)) {
  const cur = fs.readFileSync(TARGET, 'utf8');
  if (hasFix(cur)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(TARGET, FIXED);
    console.log('[DSH Addon]   established baseline proxy.fixed.js from current proxy.js');
  }
}

// 若存在正确基准版本，且 /proxy.js 未修复，则覆盖
if (fs.existsSync(FIXED)) {
  const fixedSrc = fs.readFileSync(FIXED, 'utf8');
  const targetExists = fs.existsSync(TARGET);
  const targetSrc = targetExists ? fs.readFileSync(TARGET, 'utf8') : '';
  if (!targetExists || !hasFix(targetSrc)) {
    fs.copyFileSync(FIXED, TARGET);
    console.log('[DSH Addon]   proxy.js restored to HA Ingress-fixed version from /data/dsh/proxy.fixed.js');
  } else {
    console.log('[DSH Addon]   proxy.js already has HA Ingress fixes (skipped)');
  }
} else {
  console.log('[DSH Addon]   WARNING: no proxy.fixed.js baseline found; proxy.js left as-is');
}
NODEPROXYFIX
echo "[DSH Addon] Starting HTTP proxy on 0.0.0.0:3080 -> 127.0.0.1:3081..."
node /proxy.js &
PROXY_PID=$!

# ===== 启动桥接 API（deepseek_harness 集成依赖此稳定契约）=====
echo "[DSH Addon] Starting bridge API on 0.0.0.0:${API_PORT}..."
node /api_server.js &
API_PID=$!

# ===== 子进程自愈：DSH 主进程死则整体退出，只 respawn 挂掉的 proxy/bridge =====
# 遵循评审明确的语义：
# - DSH web 主进程退出 → 整个 addon 退出，让 Supervisor 重启（干净）
# - 只有 proxy/bridge 死了、DSH 还活着 → 原地 respawn
while kill -0 ${DSH_PID} 2>/dev/null; do
    # 检查 proxy 是否还在运行
    if ! kill -0 ${PROXY_PID} 2>/dev/null; then
        echo "[DSH Addon] WARNING: proxy died, respawning..."
        node /proxy.js &
        PROXY_PID=$!
    fi
    # 检查 bridge API 是否还在运行
    if ! kill -0 ${API_PID} 2>/dev/null; then
        echo "[DSH Addon] WARNING: bridge API died, respawning..."
        node /api_server.js &
        API_PID=$!
    fi
    sleep 10
done

# DSH 主进程退出 → 清理所有子进程并退出
echo "[DSH Addon] DSH main process exited, shutting down..."
kill ${PROXY_PID} 2>/dev/null || true
kill ${API_PID} 2>/dev/null || true
