ARG BUILD_VERSION="0.1.2"
ARG BUILD_ARCH="aarch64"

# ============================================================
# 单阶段构建：直接使用 node:22-alpine 作为基础镜像
# 不使用 HA 基础镜像（避免 s6-overlay PID 1 限制）
# 配置通过 /data/options.json 读取（HA Supervisor 挂载）
# 预安装 node_modules 方式：避免 npm install 在低性能设备上超时
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
        socat \
        bash \
        curl \
        wget \
        jq \
    && mkdir -p /root/.dsh

# 复制预安装的 node_modules 压缩包并解压
COPY node_modules.tar.gz /tmp/node_modules.tar.gz
RUN mkdir -p /usr/local/lib/node_modules \
    && tar xzf /tmp/node_modules.tar.gz -C /usr/local/lib/node_modules \
    && rm -f /tmp/node_modules.tar.gz \
    && ln -sf /usr/local/lib/node_modules/.bin/dsh /usr/local/bin/dsh \
    && rm -f /usr/local/lib/node_modules/.package-lock.json 2>/dev/null

# 拷贝启动脚本
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3080 || exit 1

WORKDIR /config
CMD [ "/run.sh" ]