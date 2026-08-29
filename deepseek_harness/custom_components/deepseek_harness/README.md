# DeepSeek Harness for Home Assistant

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，一切皆插件的开源 AI Agent 框架）接入 Home Assistant，做出 **像 ha-claw 一样的集成**。

采用 **A+B 叠加架构**：

- **A（底座，配置即可）**：DSH add-on 通过 HA 原生 **MCP Server** 连接，让 agent 能读 / 控真实设备。两端都是官方稳定机制，DSH 升级不受影响。
- **B（本集成，custom_component）**：给 HA 一个原生界面——Assist 对话代理、运行时状态实体、服务、后续面板。它只通过 add-on 暴露的**稳定桥接 API** 通信，不直接依赖 DSH 易变的 RC 内部协议。

```
用户 / 语音 (Assist: Whisper + Piper)
        │  conversation
        ▼
deepseek_harness (本集成, 跑在 HA 内)
        │  HTTP 桥接 → add-on :3082
        ▼
ha-dsh-addon 容器 (DSH 运行时)
        │  MCP → 控制设备
        ▼
Home Assistant Core
```

## 安装

1. 安装并启动 `ha-dsh-addon`（DeepSeek Harness add-on），在 add-on 配置里填 API Key / 模型。
2. HACS → 自定义仓库 → 添加 `https://github.com/C3H3-AI/ha-dsh-addon`（类型：集成）。
3. 设置 → 设备与服务 → 添加集成 → 搜索 **DeepSeek Harness** → 填 add-on 主机名（默认 `deepseek_harness`）和端口（默认 `3082`）。
4. 设置 → 语音助手 → 把默认对话代理切到 **DeepSeek Harness**，即可用语音 / 文字对话。

## 接入 HA 设备（A 底座）

1. HA：设置 → 设备与服务 → 添加集成 → **MCP Server** → 选 “Home Assistant” / 开启 “Control Home Assistant”，暴露要交给 DSH 的设备。
2. add-on 选项里填 `ha_mcp_url`（MCP Server 地址，通常是 `http://supervisor/core/api/mcp` 或 `http://homeassistant:8123/api/mcp`）与 `ha_mcp_token`（长期令牌 LLT）。重启 add-on 后 DSH 自动加载 MCP 工具。

> DSH 的 MCP 客户端配置写入 `$DSH_HOME/cordis.yml` 的 `plugins:` 段，schema 为 `transport: streamable-http` + `url` + `headers`（放 LLT）。

## 当前范围

- ✅ P1：config_flow + 对话代理（Assist）+ 运行时状态 sensor + add-on 桥接 API（`/api/chat`、`/api/session`、`/api/status`、`/api/restart`）。
- ✅ 多轮会话：`/api/session` 走 DSH web 的 Typert Remote RPC（`session.create` / `session.list` / `session.history` / `session.prompt`），`sessionId` 即 HA 的 `conversation_id`，跨轮保留真实上下文，回复按 `rpcId` 关联并流式累计。
- 🚧 P2：全实体（sensor/binary_sensor/switch/button）+ services + intents。
- 🚧 P3：侧边栏面板 + diagnostics + 完整翻译。

## 多轮会话（path A）

从 v0.2.30 起，对话代理改用 **多轮会话中继** 而非 headless 一次性调用：

- 集成调用 `POST /api/session`（add-on :3082）。
- add-on 桥接层直接对接运行中的 DSH web profile（127.0.0.1:3081）的
  Typert Remote RPC 面：`session.create` / `session.list` /
  `session.history` / `session.prompt`。
- 返回的 `sessionId` 作为 HA 的 `conversation_id` 回传，后续轮次继续沿用，
  从而在 DSH 里保留真实会话上下文（记忆、工作区、工具）。
- 每次对话在 addon 的 `api_token` 下鉴权（Authorization: Bearer）。

> 该路径在 add-on 内实现，HA 集成仍只依赖稳定桥接 API，DSH 上游变更只需改 add-on。

## 注意

DSH 目前为 `v0.1-rc.x` developer preview，API 可能有 breaking change。本集成已通过 add-on 桥接层隔离，上游变更只需改 add-on，不影响 HA 侧。
