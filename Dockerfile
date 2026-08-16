ARG BUILD_FROM
FROM $BUILD_FROM

# 设置 shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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