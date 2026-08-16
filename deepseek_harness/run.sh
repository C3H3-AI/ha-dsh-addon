#!/bin/bash

set -e

# ============================================================
# DeepSeek Harness HA Addon - 启动脚本
# 不使用 bashio（避免 s6-overlay-suexec PID 1 限制）
# 直接从 /data/options.json 读取配置
# ============================================================

CONFIG_PATH=/data/options.json

# 读取配置（使用 jq 解析 JSON）
API_KEY=$(jq -r '.api_key // ""' "${CONFIG_PATH}")
MODEL=$(jq -r '.model // "deepseek-v4-flash"' "${CONFIG_PATH}")
PROVIDER=$(jq -r '.provider // "deepseek-official"' "${CONFIG_PATH}")
BASE_URL=$(jq -r '.base_url // ""' "${CONFIG_PATH}")
WORKSPACE=$(jq -r '.workspace // ""' "${CONFIG_PATH}")
PRESET=$(jq -r '.preset // "standard"' "${CONFIG_PATH}")
AUTO_START=$(jq -r '.auto_start // true' "${CONFIG_PATH}")

echo "[DSH Addon] Starting DeepSeek Harness Addon..."
echo "[DSH Addon]   Model: ${MODEL}"
echo "[DSH Addon]   Provider: ${PROVIDER}"
echo "[DSH Addon]   Preset: ${PRESET}"

# 导出环境变量供 DSH 使用
export DEEPSEEK_API_KEY="${API_KEY}"
export DSH_HOME="/root/.dsh"

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

# 启动 socat 端口转发（0.0.0.0:3080 → 127.0.0.1:3080）
# DSH 出于安全原因拒绝监听 0.0.0.0，通过 socat 让 ingress 可访问
echo "[DSH Addon] Starting socat port forwarder (0.0.0.0:3080 → 127.0.0.1:3080)..."
socat TCP-LISTEN:3080,fork,reuseaddr TCP:127.0.0.1:3080 &
SOCAT_PID=$!
echo "[DSH Addon] socat started (PID: ${SOCAT_PID})"

# 延迟一小段时间让 DSH 有机会绑定 127.0.0.1:3080
sleep 1

# 启动 DeepSeek Harness Web UI
echo "[DSH Addon] Starting DeepSeek Harness Web UI..."
cd "${DSH_WORKSPACE}" || true

# 注意：dsh web 不支持 --preset 参数，直接启动
exec dsh web