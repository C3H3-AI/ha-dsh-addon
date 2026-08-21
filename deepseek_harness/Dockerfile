ARG BUILD_VERSION="0.2.19"
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
    io.hass.description="DeepSeek Harness - 开源 AI Agent 运行框架，一切皆插件" \
    io.hass.url="https://github.com/deepseek-ai/deepseek-harness"

# 使用国内镜像源加速
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list

# 安装运行时依赖
# jq: 解析 /data/options.json（替代 bashio）
# python3 + build-essential: node-gyp 编译原生模块（node-pty 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        curl \
        wget \
        jq \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/dsh

# 安装 pnpm（用于 DSH 插件管理，dsh plugin CLI 依赖 pnpm）
# 国内网络使用 npmmirror 镜像源加速
# pnpm 8+ 默认把 global bin 目录放到 ~/.local/share/pnpm/bin（root 用户即
# /root/.local/share/pnpm/bin）。该目录默认不在 PATH，导致第一条 `pnpm config`
# 启动时自检报 "not in PATH" 构建失败。解决办法：
#  1) 先把默认 global bin 目录加入 PATH，让 pnpm 启动自检通过；
#  2) 然后显式 `global-bin-dir` 固定到 /usr/local/bin（已在 PATH）；
#  3) 同时把 /usr/local/share/pnpm、/usr/local/bin 放入 PATH，
#     保证运行时 run.sh 调用 dsh plugin 也能找到 pnpm。
ENV PATH="/usr/local/share/pnpm:/usr/local/bin:/root/.local/share/pnpm/bin:${PATH}"
RUN npm install -g pnpm \
    && pnpm config set global-bin-dir /usr/local/bin --global \
    && pnpm config set registry https://registry.npmmirror.com --global

# 安装 @deepseek-ai/dsh（使用 @next = rc.8，避免 rc.7 的 bundle 结构问题）
# latest tag (rc.7) 的 dsh-client-connection 在 rc.8 子包中被拆分为 client/host 两个入口，
# 但 rc.7 的 web-app bundle 缺少对应的 HostConnectionService 注入行，导致 ctx.connection 不存在，
# 已安装的插件（如 dsh-im）的服务端路由无法注册，返回 404。
# @next (rc.8) 已修复此问题，正确注入 connection 服务。
# 用户可通过 Web UI 一键更新按钮随时切换到 latest 或更新版本。
RUN npm install -g @deepseek-ai/dsh@next \
    && ln -sf /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh \
    && rm -f /usr/local/lib/node_modules/.package-lock.json 2>/dev/null

# 清理 vendor 目录（避免旧版本 vendor DSH 污染新安装）
# 同时清理 .npm 缓存减少镜像层大小
RUN rm -rf /data/dsh/vendor /data/dsh/vendor.tmp /data/dsh/vendor.old \
    && npm cache clean --force 2>/dev/null || true

# 拷贝启动脚本、代理、桥接 API 服务
COPY run.sh /run.sh
COPY proxy.js /proxy.js
COPY api_server.js /api_server.js
RUN chmod a+x /run.sh

# 拷贝 HA 自定义集成（custom_components）
# 容器启动时 run.sh 会复制到 /config/custom_components/，实现 addon 自带集成
COPY custom_components/ /custom_components/

# 健康检查：同时探 DSH web (3081) 与 bridge API (3082)
# 区分"web 挂"与"bridge 挂"：任一不可达都视为不健康，触发 Supervisor 重建
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3081 >/dev/null 2>&1 && wget -qO- http://127.0.0.1:3082/api/status >/dev/null 2>&1 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]