# ha-dsh-addon

[![HA][ha-badge]][ha-url]
[![HACS][hacs-badge]][hacs-url]
[![GitHub stars][stars-badge]][stars-url]
[![GitHub forks][forks-badge]][forks-url]
[![GitHub issues][issues-badge]][issues-url]
[![License: MIT][license-badge]][license-url]
[![Last commit][last-commit-badge]][last-commit-url]
[![addon v][addon-badge]][addon-url]
[![integration v][integration-badge]][integration-url]

[ha-badge]: https://img.shields.io/badge/Home%20Assistant-18BCF2.svg?style=flat-square&logo=home-assistant&logoColor=white
[ha-url]: https://www.home-assistant.io/
[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=flat-square
[hacs-url]: https://hacs.xyz/
[stars-badge]: https://img.shields.io/github/stars/C3H3-AI/ha-dsh-addon.svg?style=flat-square
[stars-url]: https://github.com/C3H3-AI/ha-dsh-addon/stargazers
[forks-badge]: https://img.shields.io/github/forks/C3H3-AI/ha-dsh-addon.svg?style=flat-square
[forks-url]: https://github.com/C3H3-AI/ha-dsh-addon/network
[issues-badge]: https://img.shields.io/github/issues/C3H3-AI/ha-dsh-addon.svg?style=flat-square
[issues-url]: https://github.com/C3H3-AI/ha-dsh-addon/issues
[license-badge]: https://img.shields.io/github/license/C3H3-AI/ha-dsh-addon.svg?style=flat-square
[license-url]: https://github.com/C3H3-AI/ha-dsh-addon/blob/main/LICENSE
[last-commit-badge]: https://img.shields.io/github/last-commit/C3H3-AI/ha-dsh-addon.svg?style=flat-square
[last-commit-url]: https://github.com/C3H3-AI/ha-dsh-addon/commits/main
[addon-badge]: https://img.shields.io/badge/addon-0.2.26-4E9AEE.svg?style=flat-square
[addon-url]: https://github.com/C3H3-AI/ha-dsh-addon/blob/main/deepseek_harness/config.yaml
[integration-badge]: https://img.shields.io/badge/integration-0.2.0-4E9AEE.svg?style=flat-square
[integration-url]: https://github.com/C3H3-AI/ha-dsh-addon/blob/main/custom_components/deepseek_harness/manifest.json

将 **DeepSeek Harness（DSH）** —— 上游开源的 AI Agent 运行框架（"一切皆插件"）—— 封装为 Home Assistant Addon。

- 通过 HA Ingress 访问 DSH Web UI（无需额外端口暴露）
- 内置桥接 API（`deepseek_harness` 自定义集成依赖此稳定契约）
- 可选接入 HA 原生 MCP Server，让 DSH 控制家里设备
- **Web 一键更新**：DSH 更新到上游最新版，无需重新发布 addon

## 快速开始

1. 将本仓库添加为 HA Add-on 仓库（Repository URL：`https://github.com/C3H3-AI/ha-dsh-addon`）
2. 安装 **DeepSeek Harness** addon
3. 配置页填写：
   - `api_key`：DeepSeek API Key（必填）
   - `api_token`：桥接 API 共享密钥（**强烈建议设置**，见下方"安全"）
   - `model` / `provider` / `base_url`：模型配置（默认 deepseek-v4-flash / deepseek-official）
   - `ha_mcp_enabled` / `ha_mcp_url` / `ha_mcp_token`：可选接入 HA MCP Server
4. 启动 addon，侧边栏出现 **DSH Agent** 面板

> 配套自定义集成：`deepseek_harness`（HA 商店可搜），用于 Assist 语音/文本对话与运行时状态传感器。

## 架构

```
[HA Ingress] ──► [HTTP 代理 :3080] ──► [DSH Web UI 127.0.0.1:3081]
                     │  (注入脚本 / 改写 host.describe)
[桥接 API :3082] ◄── [deepseek_harness 集成]
    ├ GET  /api/status      (只读, 放行)
    ├ POST /api/chat        (需 Bearer token, 60s 超时, 单飞并发锁)
    ├ POST /api/restart     (需 Bearer token)
    ├ GET  /api/update/status (需 Bearer token)
    └ POST /api/update      (需 Bearer token, 一键更新)
```

- **持久化**：所有数据在 `/data/dsh/`（会话、设置、凭据、vendor 更新）
- **DSH 安全限制**：DSH 自身禁止绑定 `0.0.0.0`，仅监听 `127.0.0.1:3081`，对外由代理接管

## 安全

- **桥接 API 共享密钥**：addon 配置 `api_token` 后，所有写操作（chat / restart / update）要求 `Authorization: Bearer <api_token>`；未配置时写操作返回 401（fail-closed）。集成侧配置时填入**相同值**。
- **仅 Ingress 暴露**：addon 不发布任何宿主端口（无 `ports`），Web UI 只能通过 HA 登录后的 Ingress 访问，避免 DSH（具备代码执行能力）暴露到局域网/公网。
- 桥接 API 监听容器内 `3082`，不映射到宿主机。

## 一键更新（DSH 本体）

DSH 处于测试期（rc.x），更新频繁。本 addon 提供 Web 一键更新，让用户**自主升级 DSH 到上游最新版**，无需维护者重新发布 addon：

1. 打开 DSH Web UI（侧边栏 → DSH Agent）
2. 进入 **设置（Settings）** 页面，底部出现 **DSH 更新** 卡片
3. 点击 → 确认 → 自动：`npm install @deepseek-ai/dsh@next` 到 `/data/dsh/vendor` → 原子切换 → 容器重启

- 更新后的 DSH 装在**持久化目录** `/data/dsh/vendor`，镜像内置版保留作离线兜底与回滚
- addon 壳只依赖 DSH 稳定契约（headless CLI 的 argv+stdout），上游接口不变则 addon 无需更新

## 数据备份

`/data/dsh/` 位于 addon 的 `/data` 目录，**随 HA 的 addon 备份自动包含**（会话记录、设置、vendor 更新均被覆盖）。无需额外备份配置。

> **注意**：卸载 addon 或变更 slug 会清空 `/data` 目录，属于预期行为。如果你需要保留对话历史，请在卸载前手动备份 `/data/dsh/`。正常更新 addon（包括 rebuild）时 `/data` 必定保留，无需担心。

## 版本通道

| 通道 | 说明 |
|------|------|
| `latest` | npm 稳定 tag（当前 rc.7） |
| `next` | npm 预发布 tag（当前 rc.8），一键更新默认目标 |

## 变更日志

### 0.2.x

- 🐛 **修复**：桥接 API `sendJson` 幂等化，杜绝 `/api/status`、`/api/restart` 在 DSH Web 响应超时时因 `timeout` + `error` 双回调二次 `writeHead` 触发 `ERR_HTTP_HEADERS_SENT` 导致的桥接进程崩溃（日志曾见 `WARNING: bridge API died, respawning...`）。

## 开发

详见 [docs/DESIGN.md](docs/DESIGN.md)（完整设计方案与关键决策记录）。

- 本地测试：`node api_server.js`（需 `DSH_API_TOKEN` 环境变量）
- 双轨版本号：addon 轨 `config.yaml` == `Dockerfile`（当前 `0.2.26`）；集成轨 `const.py` == `manifest.json`（当前 `0.2.0`）。两轨独立、不跨轨比较。CI 通过 `scripts/check-versions.sh` 校验各自一致。
- 测试与 CI：桥接 API 契约测试在 `tests/`（随仓库提交），CI（`.github/workflows/ci.yml`）跑 lint + 版本校验 + 契约测试 + 镜像构建。

## License

MIT
