#!/usr/bin/env bashio

set -e

# ============================================================
# DeepSeek Harness HA Addon - 启动脚本
# ============================================================

CONFIG_PATH=/data/options.json

# 读取配置
API_KEY=$(bashio::config 'api_key' '')
MODEL=$(bashio::config 'model' 'deepseek-v4-flash')
PROVIDER=$(bashio::config 'provider' 'deepseek-official')
BASE_URL=$(bashio::config 'base_url' '')
WORKSPACE=$(bashio::config 'workspace' '')
PRESET=$(bashio::config 'preset' 'standard')
AUTO_START=$(bashio::config 'auto_start' true)

bashio::log.info "Starting DeepSeek Harness Addon..."
bashio::log.info "  Model: ${MODEL}"
bashio::log.info "  Provider: ${PROVIDER}"
bashio::log.info "  Preset: ${PRESET}"

# 导出环境变量供 DSH 使用
export DEEPSEEK_API_KEY="${API_KEY}"
export DSH_HOME="/root/.dsh"

# 如果配置了 base_url，设置模型端点
if [ -n "${BASE_URL}" ]; then
    export DEEPSEEK_BASE_URL="${BASE_URL}"
    bashio::log.info "  Base URL: ${BASE_URL}"
fi

# 设置工作区：优先使用配置的工作区，否则默认为 /config
if [ -n "${WORKSPACE}" ]; then
    export DSH_WORKSPACE="${WORKSPACE}"
    bashio::log.info "  Workspace: ${WORKSPACE}"
else
    export DSH_WORKSPACE="/config"
    bashio::log.info "  Workspace: /config (HA 配置目录)"
fi

# 创建 DSH 数据目录
mkdir -p "${DSH_HOME}"

# 写入 DSH 配置文件（模型提供商配置）
DSH_CONFIG="${DSH_HOME}/settings.yaml"
if [ ! -f "${DSH_CONFIG}" ]; then
    bashio::log.info "Creating initial DSH configuration..."
    cat > "${DSH_CONFIG}" << EOCONFIG
models:
  default: "${PROVIDER}"
providers:
  "${PROVIDER}":
    apiKey: "${API_KEY}"
    model: "${MODEL}"
EOCONFIG
fi

# 启动 socat 端口转发（0.0.0.0:3080 → 127.0.0.1:3080）
# DSH 出于安全原因拒绝监听 0.0.0.0，通过 socat 让 ingress 可访问
bashio::log.info "Starting socat port forwarder (0.0.0.0:3080 → 127.0.0.1:3080)..."
socat TCP-LISTEN:3080,fork,reuseaddr TCP:127.0.0.1:3080 &
SOCAT_PID=$!
bashio::log.info "socat started (PID: ${SOCAT_PID})"

# 延迟一小段时间让 DSH 有机会绑定 127.0.0.1:3080
sleep 1

# 启动 DeepSeek Harness Web UI
bashio::log.info "Starting DeepSeek Harness Web UI..."
cd "${DSH_WORKSPACE}" || true

if [ "${AUTO_START}" = "true" ]; then
    exec dsh web --preset "${PRESET}"
else
    exec dsh web
fi