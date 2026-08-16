ARG BUILD_FROM
ARG BUILD_VERSION="0.1.0"
ARG BUILD_ARCH="amd64"
FROM $BUILD_FROM

# 设置 shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Labels (moved from build.yaml which is deprecated)
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.name="DeepSeek Harness" \
    io.hass.description="DeepSeek Harness - 开源 AI Agent 运行框架，一切皆插件" \
    io.hass.url="https://github.com/deepseek-ai/deepseek-harness" \
    maintainer="DeepSeek Harness HA Addon" \
    org.opencontainers.image.title="DeepSeek Harness for Home Assistant" \
    org.opencontainers.image.description="DeepSeek Harness - 开源 AI Agent 运行框架" \
    org.opencontainers.image.source="https://github.com/deepseek-ai/deepseek-harness" \
    org.opencontainers.image.version="${BUILD_VERSION}"

# 安装依赖：Node.js 22+、socat（端口转发）、其他工具
# HA 基础镜像基于 Alpine，Node.js 22.x 在 community 仓库
RUN apk add --no-cache \
        nodejs \
        npm \
        socat \
        bash \
        curl \
        wget \
    && npm install -g @deepseek-ai/dsh \
    && mkdir -p /root/.dsh

# 拷贝启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3080 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]