ARG BUILD_VERSION="0.1.3"
ARG BUILD_ARCH="aarch64"

# ============================================================
# 单阶段构建：直接使用 node:22-alpine 作为基础镜像
# 不使用 HA 基础镜像（避免 s6-overlay PID 1 限制）
# 配置通过 /data/options.json 读取（HA Supervisor 挂载）
# npm install 使用国内镜像源，避免低性能设备上超时
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

# 安装运行时依赖和编译工具
# jq: 解析 /data/options.json（替代 bashio）
# build-base + python3: node-gyp 编译原生模块（node-pty 需要）
# socat 不再需要（DSH 使用 --host 0.0.0.0 直接监听所有接口）
RUN apk add --no-cache \
        bash \
        curl \
        wget \
        jq \
        python3 \
        build-base \
    && mkdir -p /root/.dsh

# 使用国内 npm 镜像安装 @deepseek-ai/dsh
# 分两步：先设置镜像源，再安装，避免 npm install 超时
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @deepseek-ai/dsh \
    && ln -sf /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh \
    && rm -f /usr/local/lib/node_modules/.package-lock.json 2>/dev/null

# 拷贝启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3080 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]