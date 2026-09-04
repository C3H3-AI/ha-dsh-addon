# Changelog

本 addon 的版本变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.33] - 2026-09-04

### 新增

- **首次启动自动安装最新版（方案 A）**：新客户首次启动自动 `npm install @deepseek-ai/dsh@latest` 到持久化 `/data/dsh/vendor`，让新装即用稳定通道最新版；失败静默回退镜像内置版（离线兜底），下次启动自动重试。`run.sh` 新增 `install_dsh_vendor()` / `vendor_integrity_ok()`，与一键更新同源（npmmirror + vendor.tmp 原子切换）。

### 变更

- **内置版默认通道 `@next` → `@latest`**：Dockerfile 与首次自动安装均改走稳定通道（当前 `latest`/`next` 同指 `0.1.2-rc.1`）；手动一键更新保持 `next` 默认、可选 `latest`。

### 修复

- **按钮 202 契约**：`trigger_update()` 接受 200/202，修复“更新 DSH”按钮误报失败（桥接层成功返回 202，后台异步执行）。
- **按钮国际化**：`button` 平台改用 `translation_key`（en/zh-Hans 生效，英文界面不再显示中文硬编码名）；更新按钮成功后即时推送 `last_update_version`。
- **补齐 icon.png**：发布源集成目录补上 manifest 声明的 `icon.png`。

## [0.2.32] - 2026-08-30

### 新增

- **HA 界面控制按钮**：新增 `button` 平台，把 addon 桥接层早已实现但无人调用的
  `POST /api/restart` 与 `POST /api/update` 暴露为 HA 按钮实体
  （“重启 DSH” / “更新 DSH”），无需 curl 即可在 UI 与自动化中触发。
  `dsh_client` 新增 `update_status()` 与 `trigger_update(channel)`。

### 变更

- **移除 `/api/chat` headless 死代码**：该端点经 `dsh --profile headless`
  一次性调用（无记忆），自会话中继上线后集成已不再使用。删除 `runHeadless()`、
  `handleChat()`、`chatInFlight`、`CHAT_TIMEOUT_MS`、路由及 `DSHClient.chat()`。
- **契约测试迁移到 `/api/session`**：新增 `tests/mock_dsh_web.js`（mock DSH web
  profile，含完整 turn 生命周期），`DSH_WEB_PORT` 改为可经环境变量覆盖。
  12 项断言通过：status 公开、session 鉴权 401（缺/错 token）、多轮回复、
  conversation_id 复用、空消息 400、单飞锁 429。

## [0.2.31] - 2026-08-29

### 新增

- **多轮会话中继 `POST /api/session`（path A）**：addon 桥接层直接对接 DSH web profile（127.0.0.1:3081）的
  Typert Remote RPC（`session.create` / `session.list` / `session.history` / `session.prompt`，
  走 `POST /api/<endpoint>`）。`sessionId` 作为 HA 的 `conversation_id`，跨轮保留真实会话上下文。
  集成侧 `conversation.py` 改用 `chat_session()`，`dsh_client.py` 新增该方法。

### 修复

- **限流（"请求太频繁，AI 服务限流中"）**：新对话（无 conversation_id）此前会复用"最近活跃的其它会话"，
  导致所有 HA 对话被追加进同一个臃肿会话（实测 22 轮 / ~105K token / 4.15M cache-read token），
  每次请求重放巨大上下文触发 LLM provider 限流。现改为：conversation_id 存在则沿用，否则一律新建会话。
- **HA 对话在 DSH UI 里看不到**：DSH 的会话树按 workspace 分组渲染，而此前用 `session.create({})`
  建的会话未注册到任何 workspace（游离会话），因此 UI 不显示。沿用 dsh-im 的
  `adoptRegisteredWorkspaceSession` 思路修复：
  - `sessionCreatePayload()`：经 `workspace.list` 取 `workspaceId`，带它创建会话；
  - `ensureWorkspaceRegistered(id)`：对游离的既有会话，用
    `session.create({ workspaceId, sessionId })` 补认领（幂等）。
- **`conversation.py` HA 2026.x 兼容性**：HA 2026.8 移除了 `conversation.result()` 辅助函数，
  改为返回 `conversation.ConversationResult(...)`（dataclass），否则调用返回 500。
- 维护人 `@duola` → `@C3H3-AI`；集成 README 仓库地址修正。

## [0.2.30] - 2026-08-29


### 新增

- **多轮会话中继（path A）— 新增 `POST /api/session`**：addon 桥接 API 直接对接 DSH web 的 Typert Remote RPC 面（`session.create` / `session.list` / `session.history` / `session.prompt`，走 127.0.0.1:3081 的 `/api/<endpoint>`）。HA 对话跨轮保留真实上下文：`sessionId` 作为 HA 的 `conversation_id`，回复通过轮询 `session.history` 按 `rpcId` 关联并累计 `assistant/chunk` 文本，`turn/end` 时返回。
- **集成改用 `chat_session`**：`conversation.py` 通过 `/api/session` 走多轮会话，首次调用返回 `sessionId` 作为后续轮次 conversation_id；`dsh_client.py` 新增 `chat_session(message, session_id)`。
- **`_detect_addon_host`**：集成启动时经 Supervisor API 自动探测真实 addon hostname，解决第三方仓库 slug 前缀不一致导致的默认主机名解析失败。

### 修复

- **`manifest.json` 维护人 `@duola` → `@C3H3-AI`**；集成版本 0.2.1，支持 UI 重新配置（`reconfigure`）。

## [0.2.29] - 2026-08-29


### 移除

- **proxy.js — 移除 `mobileCss` 移动端 CSS 注入**：移动端适配改由 `dsh-mobile-fix` 插件负责，代理不再注入移动端样式，避免与插件冲突。
- **proxy.js — 移除 `updateUiScript` 一键更新 UI 注入**：不再往 DSH 设置页面注入版本/更新按钮。

## [0.2.28] - 2026-08-27

### 修复

- **proxy.js — React 创建的 `<iframe>` 加载失败**：`dsh-mcp-connector` 的 iframe 由 React/JSX 创建，其 `src` 通过 `Element.setAttribute("src", ...)` 设置，**不会触发** `HTMLIFrameElement.prototype.src` 的 setter。此前只 hook 了 src setter，导致 React 创建的 iframe 仍以不带 Ingress 前缀的绝对路径加载而返回 404。
  - 现新增 hook `Element.prototype.setAttribute`：当以 `src` 属性设置时同样补上 Ingress 前缀，彻底修复 MCP 连接器页面 404 的问题。

## [0.2.27] - 2026-08-27

### 修复

- **proxy.js — HA Ingress 下的动态资源加载**：修复在 HA Ingress 反向代理下，多个插件动态注入的资源因绝对路径不带 Ingress 前缀而加载失败的问题。
  - `dsh-mcp-connector` 的 iframe 页面（`/mcp-connector/ui/`）此前会返回 404；现已通过 hook `HTMLIFrameElement` 的 `src` 补上 Ingress 前缀。
  - `dsh-better-sidebar` 的懒加载 chunk（`/sidebar/bundle/*.js`）此前返回 403/404；现已通过 hook `HTMLScriptElement` 的 `src` 补上 Ingress 前缀。
- **proxy.js — WebSocket 连接**：`rewrite()` 的跨源判断由"比较完整 origin"改为"只比较 host（hostname:port）"，避免 `wss://` 与页面 `https://` 因协议不同被误判为跨源而跳过前缀补写，从而修复终端等 WebSocket 连接失败（如 1006）的问题。
- **proxy.js — query 参数保留**：URL 重写时保留 `?query` 参数，避免带查询串的请求丢失参数。

### 改进

- **run.sh — 启动自愈**：每次启动 addon 时自动检测并修复 `proxy.js`（幂等）。即使容器重建后 `proxy.js` 被镜像还原成旧版，也能自动恢复为包含 HA Ingress 修复的正确版本，避免上述问题复发。

### 文档

- **addon 描述与首页链接**：`config.yaml` 与 `Dockerfile` 中 addon 的描述改为"DeepSeek Harness Home Assistant 加载项"，"更多详情"链接指向本 addon 仓库，便于使用者查看源码与使用说明。

## [0.2.26]

- 初始/上一正式版本。见仓库历史提交记录。
