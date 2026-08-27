ARG BUILD_VERSION="0.2.27"
ARG BUILD_ARCH="aarch64"
ARG BUILD_FROM="node:22-bookworm-slim"

# ============================================================
# 单阶段构建：使用 node:22-bookworm-slim（Debian 基础镜像）
# 不使用 Alpine（避免 node-pty 等原生模块的 musl/glibc 兼容性问题）
# 不使用 HA 基础镜像（避免 s6-overlay PID 1 限制）
# 配置通过 /data/options.json 读取（HA Supervisor 挂载）
# npm install 使用国内镜像源，避免低性能设备上超时
# build_from 由 build.yaml 传入，需在 FROM 之后才能在 LABEL/后续使用
# ============================================================
FROM ${BUILD_FROM}

# 重新声明 ARG 使其在构建阶段可用（预声明在 FROM 之前的 ARG 不在同一作用域）
ARG BUILD_VERSION
ARG BUILD_ARCH

# Labels
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.name="DeepSeek Harness" \
    io.hass.description="DeepSeek Harness Home Assistant 加载项 - 在 HA 中运行开源 AI Agent 框架，一切皆插件" \
    io.hass.url="https://github.com/C3H3-AI/ha-dsh-addon"

# 使用国内镜像源加速
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list

# 安装运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        curl \
        wget \
        jq \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/dsh

ENV PATH="/usr/local/share/pnpm:/usr/local/bin:/root/.local/share/pnpm/bin:${PATH}"
RUN npm install -g pnpm \
    && pnpm config set global-bin-dir /usr/local/bin --global \
    && pnpm config set registry https://registry.npmmirror.com --global

RUN npm install -g @deepseek-ai/dsh@next \
    && ln -sf /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh \
    && rm -f /usr/local/lib/node_modules/.package-lock.json 2>/dev/null

RUN rm -rf /data/dsh/vendor /data/dsh/vendor.tmp /data/dsh/vendor.old \
    && npm cache clean --force 2>/dev/null || true

COPY run.sh /run.sh
COPY proxy.js /proxy.js
COPY api_server.js /api_server.js
RUN chmod a+x /run.sh

# 拷贝 HA 自定义集成（custom_components）
# 容器启动时 run.sh 会复制到 /config/custom_components/，实现 addon 自带集成
COPY custom_components/ /custom_components/

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3081 >/dev/null 2>&1 && wget -qO- http://127.0.0.1:3082/api/status >/dev/null 2>&1 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]