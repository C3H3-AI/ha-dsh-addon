ARG BUILD_FROM
ARG BUILD_VERSION="0.1.0"
ARG BUILD_ARCH="amd64"

# ============================================================
# Stage 1: 构建阶段 - 使用 node:22-alpine 预编译 dsh
# ============================================================
FROM node:22-alpine AS dsh-builder

# 使用国内镜像源加速
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories

# 安装构建工具（编译 native 模块需要）
RUN apk add --no-cache build-base python3

# 配置 npm 镜像并安装 @deepseek-ai/dsh
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @deepseek-ai/dsh --ignore-scripts=false

# ============================================================
# Stage 2: 最终镜像 - 使用 HA 基础镜像，拷贝 dsh 成品
# ============================================================
FROM $BUILD_FROM

# 设置 shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Labels
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

# 使用国内镜像源加速
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories

# 安装运行时依赖（仅需 nodejs，不需要 build-base/gcc）
RUN apk add --no-cache \
        nodejs \
        npm \
        socat \
        bash \
        curl \
        wget \
    && mkdir -p /root/.dsh

# 从构建阶段拷贝预编译的 dsh 及其依赖
COPY --from=dsh-builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=dsh-builder /usr/local/bin/dsh /usr/local/bin/dsh

# 拷贝启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3080 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]