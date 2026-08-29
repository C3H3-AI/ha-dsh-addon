# DeepSeek Harness for Home Assistant

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，一切皆插件的开源 AI Agent 框架）接入 Home Assistant。

> **重要：接的是 Agent，不是聊天模型。**
> 本集成把 HA 对话接进 DSH 的 **Agent 运行时**——它有 13,430 字的 agent 系统提示、挂载 **223 个工具**（其中 168 个来自 MCP）、多轮会话记忆、权限与沙箱。底层 LLM（`workbuddy/hy4-preview` 等）只是 agent 在推理中会去调用的一个"大脑"，不是直接对话的对象。

## 架构

```
用户 / 语音 (Assist pipeline)
        |
        v
HA conversation.deepseek_harness        <- 本集成 (custom_components)
        |  POST /api/session   (Bearer api_token, :3082)
        v
addon 桥接层 api_server.js              <- 协议转换 / 鉴权 / 会话管理
        |  POST /api/session.*  (127.0.0.1:3081)
        v
DSH web profile (Agent 运行时)
        ├─ 223 工具 (MCP / 文件 / bash / 技能 / 子代理)
        ├─ 持久化会话 (/data/dsh/sessions)
        ├─ 权限 + 沙箱 (Workspace Write)
        └─ 逐步推理 turn / step
              ↓ 需要时
        LLM (local-ai-proxy → workbuddy/hy4-preview)
```

三层职责：

| 层 | 位置 | 职责 |
|----|------|------|
| **HA 集成** | `custom_components/` | Assist 对话代理、状态 sensor；把 DSH 回复包装成 HA `ConversationResult` |
| **addon 桥接层** | `api_server.js` | 鉴权、会话生命周期、**异步 RPC → 同步问答**的协议转换 |
| **DSH Agent** | addon 容器内 | 真正的 agent：工具、记忆、推理编排 |

> 桥接层是必需的：DSH 的 `session.prompt` 是"发完立刻返回 `{accepted:true}`"的异步 RPC，
> 回复要另外轮询 `session.history` 并按 `rpcId` 关联、拼接 assistant 文本。
> 这段"发消息 → 等 → 取回复"的逻辑在 `api_server.js` 的 `relaySession()` 里，DSH 本身不提供这种同步接口。

## 安装

1. 安装并启动 `ha-dsh-addon`（DeepSeek Harness add-on）。
2. HACS → 自定义仓库 → 添加 `https://github.com/C3H3-AI/ha-dsh-addon`（类型：集成）。
3. 设置 → 设备与服务 → 添加集成 → 搜索 **DeepSeek Harness** → 填 add-on 主机名与端口（默认 `3082`）。
   - 主机名会自动经 Supervisor API 探测真实 addon slug（第三方仓库前缀不同也能识别）。
4. **两边填相同的 `api_token`**（addon 配置 + 集成配置），否则写操作返回 401（fail-closed）。
5. 设置 → 语音助手 → 把对话代理切到 **DeepSeek Harness**。

## 多轮会话中继（path A）

对话走 `POST /api/session`，使用 DSH 真实会话：

- 集成调 `POST /api/session`（addon :3082），带 `Authorization: Bearer <api_token>`。
- 桥接层调 DSH 的 Typert Remote RPC：`session.create` / `session.list` / `session.history` / `session.prompt`。
- 返回的 `sessionId` 作为 HA 的 `conversation_id` 回传并沿用 → **跨轮保留真实上下文**。
- 会话规则：**conversation_id 存在且有效则复用（多轮）；否则新建会话**。
  （早期版本会复用"最近活跃的其它会话"，导致所有对话堆积进一个臃肿会话而触发限流，已修。）

### 会话与 DSH 界面

DSH 的会话树**按 workspace 分组渲染**。会话必须注册到 workspace 才会显示在 DSH 界面。
桥接层已处理（沿用 [dsh-im](https://github.com/xmanrui/dsh-im) 的 `adoptRegisteredWorkspaceSession` 思路）：

- 新建会话时带 `workspaceId`（经 `workspace.list` 取得）；
- 对已存在但游离的会话，用 `session.create({ workspaceId, sessionId })` 补认领。

因此 HA 里发起的对话会出现在 DSH 界面的会话列表中。

## 桥接 API

| 端点 | 用途 | 状态 |
|------|------|------|
| `POST /api/session` | **多轮会话中继（当前对话路径）** | ✅ 集成在用 |
| `GET /api/status` | 状态探针（online / DSH 可达） | ✅ sensor 在用 |
| `POST /api/restart` | 重启 DSH 运行时 | ⚠️ 已实现，**HA 界面未接** |
| `POST /api/update` | 一键更新 DSH（装到 `/data/dsh/vendor`） | ⚠️ 已实现，**HA 界面未接** |
| `GET /api/update/status` | 查当前/最新/next 版本 | ⚠️ 已实现，未接 |
| `GET /api/update/result` | 查上次更新结果 | ⚠️ 已实现，未接 |
| `POST /api/chat` | headless 一次性调用（无记忆） | 🗑 旧路径，集成已不再调用 |

> 重启 / 一键更新目前只能用 curl 手动触发（见下）。接进 HA 界面（button 实体或 service）是后续项。

手动触发：

```bash
TOKEN=<你的 api_token>
curl -X POST -H "Authorization: Bearer $TOKEN" http://<addon-host>:3082/api/restart
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"channel":"next"}' \
     http://<addon-host>:3082/api/update
curl -H "Authorization: Bearer $TOKEN" http://<addon-host>:3082/api/update/status
```

## 接入 HA 设备（可选）

让 agent 真正读 / 控设备，需要 **HA MCP Server** 联通：

1. HA：设置 → 设备与服务 → 添加集成 → **MCP Server** → 开启 “Control Home Assistant”。
2. 在 DSH 的 MCP 连接器里配置该 webhook 地址与长期令牌（LLT）。

联通后 agent 会获得 11 个 HA 工具（`ha_get_overview` / `ha_search` /
`ha_call_read_tool` / **`ha_call_write_tool`**（通用写，可控设备）/
`ha_config_get_automation` / `ha_config_set_automation` 等）。

> ⚠️ 状态提示：本部署实测 HA MCP 连接器（`custom-ha_mcp`）当前为**停用**状态
> （健康检查 0 正常、调用返回 transport error），因此 agent 暂时读不到 HA 实体。
> 修好连接器后语音控设备即可生效。

## 版本与兼容

- addon：`config.yaml` 的 `version`；集成：`const.py` 的 `VERSION` / `manifest.json` 的 `version`。
- HA **2026.8** 起移除了 `conversation.result()`，必须返回 `conversation.ConversationResult(...)`。
- DSH 为 developer preview，API 可能有 breaking change；本集成经 addon 桥接层隔离，上游变更只需改 addon。

## 已验证

- 多轮记忆：连续两轮问答，第二轮能回忆第一轮内容。
- 会话可见：HA 发起的对话出现在 DSH 界面会话树（如 “测试通过”）。
- 工具调用：agent 会加载 `ha-mcp` 技能并调用 HA MCP 工具（连通性取决于连接器配置）。
- 移动端 UI：`dsh-mobile-fix` 插件（设置界面单栏化 + 双击最大化）已验证生效。
