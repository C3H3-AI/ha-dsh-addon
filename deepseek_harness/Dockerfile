ARG BUILD_VERSION="0.1.2"
ARG BUILD_ARCH="amd64"

# ============================================================
# 单阶段构建：直接使用 node:22-alpine 作为基础镜像
# 不使用 HA 基础镜像（避免 s6-overlay PID 1 限制）
# 配置通过 /data/options.json 读取（HA Supervisor 挂载）
# ============================================================
FROM node:22-alpine

# Labels
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.name="DeepSeek Harness" \
    io.hass.description="DeepSeek Harness - 开源 AI Agent 运行框架，一切皆插件" \
    io.hass.url="https://github.com/deepseek-ai/deepseek-harness"

# 使用国内镜像源加速
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories

# 安装运行时依赖
# socat: 端口转发（dsh 只监听 127.0.0.1）
# jq: 解析 /data/options.json（替代 bashio）
RUN apk add --no-cache \
        nodejs \
        npm \
        socat \
        bash \
        curl \
        wget \
        jq \
        build-base \
        python3 \
    && mkdir -p /root/.dsh

# 配置 npm 镜像并安装 @deepseek-ai/dsh
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @deepseek-ai/dsh

# 拷贝启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3080 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]