# DeepSeek Harness HA Addon — Code Wiki

> 项目仓库：`https://github.com/c3h3-ai/ha-dsh-addon`
> 维护者：C3H3-AI
> 当前 addon 版本：`0.2.17`；配套集成版本：`0.2.0`
> 文档定位：面向开发/维护者的代码导航手册，覆盖架构、模块、关键类/函数、依赖与运行方式。设计决策与深挖细节见 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 目录

1. [项目是什么](#1-项目是什么)
2. [整体架构](#2-整体架构)
3. [仓库结构总览](#3-仓库结构总览)
4. [模块一：Add-on 启动脚本 run.sh](#4-模块一add-on-启动脚本-runsh)
5. [模块二：Ingress HTTP/WS 代理 proxy.js](#5-模块二ingress-httpws-代理-proxyjs)
6. [模块三：桥接 API api_server.js](#6-模块三桥接-api-apiserverjs)
7. [模块四：HA 自定义集成（Python）](#7-模块四ha-自定义集成python)
8. [模块五：容器与构建配置](#8-模块五容器与构建配置)
9. [依赖关系](#9-依赖关系)
10. [项目运行方式](#10-项目运行方式)
11. [测试与 CI](#11-测试与-ci)
12. [关键架构决策速查](#12-关键架构决策速查)

---

## 1. 项目是什么

把 **DeepSeek Harness（DSH）** —— 上游开源的 AI Agent 运行框架（"一切皆插件"，所属 npm 包 `@deepseek-ai/dsh`）——封装进 Home Assistant，对外提供三种能力：

- **DSH Web UI**：经 HA Ingress 访问（聊天 / Agent），不额外暴露端口。
- **桥接 API**：供配套 HA 集成 `deepseek_harness` 调用的稳定 HTTP 契约。
- **HA 设备控制（可选）**：DSH 通过 HA 原生 MCP Server 读 / 控设备。
- **Web 一键更新**：用户在 DSH Web 界面内即可把 DSH 升级到上游最新 rc，无需维护者重发 addon。
- **插件管理**：用户在浏览器内可直接安装/卸载 DSH 插件（通过 `dsh plugin` CLI + pnpm）。

仓库由**两个独立发布轨道**组成：

| 轨道 | 形态 | 语言 | 版本 |
|------|------|------|------|
| Add-on 壳 | `deepseek_harness/` 目录 + Docker 镜像 | Bash + Node.js | `0.2.17` |
| 自定义集成 | `custom_components/deepseek_harness/`（HA 商店可装） | Python | `0.2.0` |

> **A+B 架构**：Add-on 通过 HA 原生 MCP Server 连 HA（A 底座，配置即可）；自定义集成为 HA 提供原生对话/实体（B 壳），二者之间只走**稳定桥接 API**，不触碰 DSH 易变的 RC 内部协议。

---

## 2. 整体架构

### 2.1 运行拓扑

```
┌────────────────────────── 容器内 ──────────────────────────┐
│                                                            │
│   [HA Ingress] ──► [HTTP 代理 0.0.0.0:3080]  (proxy.js)     │
│                          │ 注入 <base>/脚本/改写响应         │
│                          ▼                                 │
│              [DSH Web UI 127.0.0.1:3081]  (dsh --profile web)│
│                   │       ▲                                │
│                   │       │ WebSocket (upgrade)            │
│                   ▼       │                                │
│   [桥接 API 0.0.0.0:3082] ──► DSH headless（单轮 one-shot）  │
│       ├ GET  /api/status          (只读, 免鉴权)            │
│       ├ POST /api/chat            (需 Bearer, 60s, 单飞锁)  │
│       ├ POST /api/restart         (需 Bearer)              │
│       ├ GET  /api/update/status   (需 Bearer)              │
│       ├ POST /api/update          (需 Bearer, 一键更新)     │
│       ├ GET  /api/update/result   (需 Bearer, 前端轮询)     │
│       ├ GET  /api/plugin/list     (只读, 免鉴权)            │
│       ├ POST /api/plugin/install  (需 Bearer, 插件安装)     │
│       └ POST /api/plugin/uninstall(需 Bearer, 插件卸载)     │
│                                                            │
│   [HTTP 代理 0.0.0.0:3080] 内部 relay:                      │
│       ├ /__dsh_update/*  → bridge API（注入 token）         │
│       └ /__dsh_plugin/*  → bridge API（注入 token）         │
│                                                            │
│   持久化目录 /data/dsh/（Supervisor 保证更新时保留）           │
│     ├ settings.yaml     （模型/提供商配置）                  │
│     ├ cordis.patch.yml  （HA MCP 插件注入，顶层数组）        │
│     ├ sessions/ storages/（会话/工作区元数据）              │
│     └ vendor/           （Web 一键更新到的最新 DSH 本体）    │
└────────────────────────────────────────────────────────────┘
```

### 2.2 三个运行进程 + 插件管理（由 run.sh 拉起）

启动脚本 `run.sh` 同时拉起 3 个进程，均作为子进程前台运行：

| 进程 | 命令 | 监听端口 | 职责 |
|------|------|---------|------|
| **DSH Web** | `node --expose-internals <DSH_BIN> --profile web --host 127.0.0.1 --port 3081` | 127.0.0.1:3081 | DSH 本体，只回环监听 |
| **HTTP 代理** | `node /proxy.js` | 0.0.0.0:3080 | Ingress 接入 + 内容改写 + WS 转发 + 更新/插件管理 relay |
| **桥接 API** | `node /api_server.js` | 0.0.0.0:3082 | 对集成暴露稳定契约 + 一键更新 + 插件管理端点 |

> 插件管理可通过桥接 API 的 `dsh plugin` CLI 调用 pnpm 安装卸载，也可通过 proxy 注入的浏览器 UI 直接操作。

> **为何 DSH 只监听回环？** DSH 自带安全限制禁止绑定 `0.0.0.0`（避免把远程代码执行能力暴露到网络），因此对外统一交给代理接管。

### 2.3 集成侧数据流（语音/文字对话）

```
用户（Assist: 文本或 Whisper + Piper 语音）
        │ conversation.async_agent
        ▼
deepseek_harness（集成, 跑在 HA 内）
  └─ DeepseekConversationAgent.async_process()
        │ POST /api/chat {message, session?}
        ▼
ha-dsh-addon 容器 api_server.js
  └─ runHeadless(message) → spawn(dsh --profile headless message)
        │ HA MCP（可选）→ 控制设备
        ▼
Home Assistant Core
```

---

## 3. 仓库结构总览

```
ha-dsh-addon/
├── .github/workflows/ci.yml               # CI：lint / 版本校验 / 契约测试 / Docker 构建
├── repository.yaml                        # Add-on 仓库声明
├── custom_components/deepseek_harness/    # ★ 配套 HA 集成（Python）
│   ├── __init__.py                        # 集成 setup / unload
│   ├── config_flow.py                     # 配置流程
│   ├── const.py                           # 常量 + 版本
│   ├── conversation.py                    # Assist 对话代理
│   ├── dsh_client.py                      # 桥接 API 客户端
│   ├── sensor.py                          # 运行时状态传感器
│   ├── manifest.json                       # HA 集成清单
│   ├── hacs.json                           # HACS 声明
│   ├── README.md                          # 集成使用说明
│   └── translations/{zh-Hans,en}.json     # 翻译
├── deepseek_harness/                      # ★ Add-on 本体
│   ├── config.yaml                        # Add-on 清单/配置 schema
│   ├── Dockerfile                          # 镜像构建
│   ├── build.yaml                          # build_from（构建基础镜像）
│   ├── run.sh                             # 启动脚本
│   ├── proxy.js                            # Ingress HTTP/WS 代理
│   ├── api_server.js                       # 桥接 API
│   └── icon.png / logo.png                # UI 图标
├── docs/                                  # 设计文档与修复记录
│   ├── DESIGN.md                          # 完整设计方案（权威参考）
│   ├── OPTIMIZATION-RESPONSE.md
│   ├── REPORT-dsh-im-404(-v2).md
│   └── REVIEW-RESPONSE.md
├── scripts/check-versions.sh              # 双轨版本一致性校验
└── tests/                                 # 桥接 API 契约测试
    ├── mock_dsh.js
    └── test_bridge_api.js
```

---

## 4. 模块一：Add-on 启动脚本 run.sh

**文件**：`deepseek_harness/run.sh`
**语言**：Bash（不使用 bashio，直接读 `/data/options.json`，规避 s6-overlay PID 1 限制）

### 4.1 职责

启动 DSH、代理、桥接 API 三个进程，并负责配置解析、持久化自检、MCP 注入、版本解析与子进程自愈。

### 4.2 执行流程

| 步骤 | 说明 |
|------|------|
| 1. 读配置 | 从 `/data/options.json` 读取（`jq`），失败回退 `$HASSIO_OPTIONS` 环境变量，再失败用默认值 |
| 2. 导出环境变量 | `DEEPSEEK_API_KEY`、`DSH_API_TOKEN`、**`DSH_HOME=/data/dsh`**（关键持久化）、`DSH_API_PORT` |
| 3. 解析 DSH 运行路径 | 优先 `vendor/` 新版（一键更新所得），校验其完整性后使用，损坏则删除回退镜像内置版 |
| 4. 设置工作区/BaseURL | `DSH_WORKSPACE` 默认 `/config`（经 `map: config:rw` 持久化）；配了 `base_url` 则导出 `DEEPSEEK_BASE_URL` |
| 5. 数据自检探针 | 只读检查 DSH_HOME 可写性、sessions 数量、settings.yaml、storages/ 存在性；`/data` 不可写则 `exit 1` 让 Supervisor 标记失败 |
| 6. 生成 settings.yaml | 仅当不存在时按 options 生成（模型 + provider + apiKey） |
| 7. A 底座：注入 MCP | 若启用 `ha_mcp`，写 `$DSH_HOME/cordis.patch.yml`（顶层 YAML 数组 + `insert:`）注入 `@deepseek-ai/dsh-mcp-client` |
| 8. B 底座：dsh-im RPC 补丁 | 就地改写插件 bundle 中 `rpcAuthority` 为 `trusted-host`（绕过 IP 校验） |
| 9. 打印 DSH 版本 | 仅显示，不自动更新（`npm update -g` 会破坏只读层） |
| 10. 启动 DSH Web | `node --expose-internals <DSH_BIN> --profile web --host 127.0.0.1 --port 3081 &`，轮询直至就绪 |
| 11. 启动代理 | `node /proxy.js &`（0.0.0.0:3080） |
| 12. 启动桥接 API | `node /api_server.js &`（0.0.0.0:$API_PORT） |
| 13. 子进程自愈 | `while kill -0 $DSH_PID` 循环：proxy/bridge 死了则原地 respawn；**DSH 主进程死则清理子进程并整体退出**，交由 Supervisor 干净重启 |

### 4.3 关键函数/环境变量

| 标识 | 类型 | 说明 |
|------|------|------|
| `CONFIG_PATH=/data/options.json` | 常量 | Supervisor 挂载的 addon 配置 |
| `VENDOR_DIR=/data/dsh/vendor` | 常量 | 一键更新安装新版 DSH 的持久化目录 |
| `DSH_IM_PATCH` | 导出变量 | dsh-im 插件 patch 文件路径 |
| 内联 `node -e` 校验 | 逻辑 | 校验 vendor DSH 的 package.json + 全部依赖可 `require.resolve`，防 `Cannot find package` |
| dsh-im 正则改写 | 逻辑 | `^(\s*)name: '@xmanrui\/dsh-im'$` → 插入 `config:\n rpcAuthority: trusted-host` |
| 子进程自愈 while 循环 | 逻辑 | `kill -0 $DSH_PID` 存活判据 |

---

## 5. 模块二：Ingress HTTP/WS 代理 proxy.js

**文件**：`deepseek_harness/proxy.js`
**语言**：Node.js（纯 `http`/`net`，无第三方依赖）

### 5.1 职责

作为 Ingress 与 DSH 之间的 HTTP/WebSocket 代理，解决 SPA 绝对路径、`isLoopback` 持久化伪装、Host/Origin 校验、一键更新中转等一系列问题。

### 5.2 HTTP 处理流程

| 分支 | 触发条件 | 动作 |
|------|---------|------|
| 诊断端点 | `url === '/__proxy_diag'` | 返回 JSON（状态/端口/ingress/remote），独立验证代理可用 |
| 目标路径剥离 | 始终 | 先去掉 `X-Ingress-Path` 前缀，后续判断基于 `targetPath` |
| 一键更新中转 | `targetPath` 以 `/__dsh_update` 开头 | 仅允许带 `x-ingress-path`（ingress 来源），否则 403；转 `:3082` 的 `/api` + 剥离后缀，并注入 `Authorization: Bearer`（浏览器不持 token） |
| 插件管理中转 | `targetPath` 以 `/__dsh_plugin` 开头 | 与更新中转同模式，转 `:3082` 的 `/api/plugin/*`，注入 token，仅限 ingress 来源 |
| 改写 dsh-client   | `pathOnly.endsWith('/plugins/@deepseek-ai/dsh-client-connection/client.js')` 且 JS | 精确正则把 `isLoopback: (...)` 替换为 `isLoopback: true`，兜底替换非 true 值；未命中输出 WARNING |
| 改写 HTML | `content-type` 为 html 且有 ingress 前缀 | 注入 `<base href>`、移动端 CSS、loopback 修复脚本、crypto polyfill、ingress fetch/WebSocket patch、storage 诊断、一键更新 UI；重写 `src/href`、`"url":"/plugins/` 带前缀 |
| 改写 host.describe | `pathOnly === '/api/host.describe'` 且 JSON | 递归把所有 `hostname` 字段改为 `127.0.0.1` |
| 普通转发 | 其余 | 清洗 `transfer-encoding`/`content-length` 后转发 |

### 5.3 WebSocket Upgrade 流程

- 去 Ingress 前缀后，用 `net.connect` 直连 `127.0.0.1:3081`。
- 手工拼 HTTP Upgrade 报文，重写头部：
  - `Host` → `127.0.0.1:3081`
  - `Origin` → `http://127.0.0.1:3081`
  - 丢弃 `x-ingress-path` / `proxy-connection`
- **为什么改 Host/Origin**：DSH 后端 `isTrustedApiRequest` 校验 Host 必须是 loopback/trustedHosts，且 Origin 的 host 需与 Host 一致，否则 403。

### 5.4 关键常量/说明

| 常量 | 值 | 说明 |
|------|-----|------|
| `DSH_PORT` | 3081 | DSH 后端 |
| `PROXY_PORT` | 3080 | 代理监听 |
| `BRIDGE_PORT` | env `DSH_API_PORT` 默认 3082 | 桥接 API |
| `BRIDGE_TOKEN` | env `DSH_API_TOKEN` | 中转更新端点时注入 |

**注入脚本集**（HTML `<head>` 注入顺序）：
1. `<base>` 标签
2. `mobileCss`（≤768px 对话框全屏 + `safe-area-inset-bottom` + 表单 16px）
3. `loopbackFixScript`（覆盖 `Location.prototype.hostname/host` 返回 `127.0.0.1`）
4. `cryptoPolyfillScript`（`crypto.randomUUID` polyfill）
5. `ingressFixScript`（重写 `fetch`/`WebSocket`，`/api/` → `ORIGIN+BASE+path`）
6. `storageDiagScript`（`[storage]` 日志输出 localStorage 键/数据）
7. `updateUiScript`（右下角浮动 DSH 更新按钮 + 设置页按钮 + MutationObserver）
8. `pluginUiScript`（浮动绿色「插件」按钮 + 面板 + 安装/卸载列表 + 输入框）

---

## 6. 模块三：桥接 API api_server.js

**文件**：`deepseek_harness/api_server.js`
**语言**：Node.js（纯 `http`/`child_process`/`fs`，无第三方依赖）

### 6.1 职责

对 HA 集成暴露**版本稳定契约**，把易变的 DSH RC 内部封装在容器内。

### 6.2 路由表

| 方法/路径 | 鉴权 | 行为 |
|-----------|------|------|
| `GET /api/status` | ❌ 免鉴权 | 探测 `127.0.0.1:3081`，返回 `{online, dsh, bridge, note}` |
| `GET /api/update/status` | ❌ 免鉴权（设计上只读） | `npm view dist-tags` + 本地 vendor 存在性 → 返回 `{current, usingVendor, latest, next, registry...}` |
| `GET /api/update/result` | ❌ 免鉴权 | 返回后台更新进度 `{status: idle|installing|done|error}` |
| `POST /api/chat` | ✅ Bearer | 单飞锁 → `runHeadless(message)` → `{text}`；超时 60s；缺 message 400；并发 429 |
| `POST /api/restart` | ✅ Bearer | 调 Supervisor `/addons/<slug>/restart`（需 `SUPERVISOR_TOKEN`） |
| `POST /api/update` | ✅ Bearer | `{channel: latest\|next}`，后台 `npm install` 到 `vendor.tmp` → 原子改名 → 写 `.updated` 标记 → 触发容器重启，先回 202 |
| `GET /api/plugin/list` | ❌ 免鉴权（只读） | 读取 `$DSH_HOME/profiles/web/package.json` 返回 `{plugins: [...], count: N}` |
| `POST /api/plugin/install` | ✅ Bearer | `{package: "pkg-name"}`，后台 `spawn` 运行 `dsh plugin --profile web add <pkg>`，超时 120s |
| `POST /api/plugin/uninstall` | ✅ Bearer | `{package: "pkg-name"}`，后台 `spawn` 运行 `dsh plugin --profile web remove <pkg>`，超时 120s |

> 刷新规则：命中即匹配路由；只读三类端点免 token，其余（含未知路径）一律先过 `tokenMatches`，未通过返回 401（fail-closed）。

### 6.3 关键函数

| 函数 | 作用 |
|------|------|
| `tokenMatches(header)` | **常量时间**比较 Bearer token（逐字符 XOR），避免时序侧信道 |
| `sendJson(res, code, obj)` | 统一 JSON 应答（含 Content-Length） |
| `readBody(req)` | 收集请求体，>1MB 销毁连接 |
| `runHeadless(message, timeoutMs)` | `spawn(node --expose-internals DSH_BIN --profile headless message)`，收集 stdout/stderr，超时 SIGKILL，60s 上限 |
| `handleChat` / `handleStatus` / `handleRestart` | 对应路由处理器 |
| `handleUpdate` / `runUpdate` / `handleUpdateStatus` / `handleUpdateResult` | 一键更新：后台安装、原子切换、状态机（`updateInFlight` 锁 + `updateResult` 状态） |
| `currentDshVersion()` | 读取 DSH 的 package.json 版本 |
| `runPluginCommand(args)` | `spawn(node ... plugin --profile web <args>)`，收集 stdout/stderr，超时 120s |
| `handlePluginInstall` / `handlePluginUninstall` / `handlePluginList` | 插件管理：调用 `runPluginCommand` 转发给 `dsh plugin` CLI，对 `/api/plugin/*` 路由 |
| `npmDistTags()` | `npm view @deepseek-ai/dsh dist-tags`（20s 超时，走 npmmirror） |
| `triggerRestart()` | fire-and-forget 调 Supervisor 重启 |

### 6.4 一键更新状态机

```
handleUpdate (202 立即返回)
  → runUpdate(channel):
      rm vendor.tmp → npm install @deepseek-ai/dsh@<channel> --prefix vendor.tmp
      → 校验 tmpBin 存在
      → rm vendor.old → rename vendor→vendor.old → rename vendor.tmp→vendor
      → 写 /data/dsh/vendor/.updated
      → updateResult='done' → setTimeout(1.5s) triggerRestart()（异步热重启）
   出错 → updateResult='error'，释放 updateInFlight 允许重试
```

---

## 7. 模块四：HA 自定义集成（Python）

**目录**：`custom_components/deepseek_harness/`

### 7.1 各文件职责

| 文件 | 职责 |
|------|------|
| `const.py` | `DOMAIN = "deepseek_harness"`、`VERSION = "0.2.0"`、配置键与默认值（host=`deepseek_harness`、port=`3082`、timeout=`180`） |
| `__init__.py` | `async_setup_entry` 建 `DSHClient` 存入 `hass.data[DOMAIN][entry.entry_id]`，转发 conversation/sensor 平台；`async_unload_entry` 卸载并关闭 client |
| `config_flow.py` | `DeepseekConfigFlow.async_step_user` 收集 host/port/timeout/api_token 并 `async_create_entry` |
| `dsh_client.py` | `DSHClient`：异步 HTTP 客户端 + `DSHClientError` |
| `conversation.py` | `DeepseekConversationAgent`：Assist 对话代理 |
| `sensor.py` | `DSHRuntimeSensor`：运行时状态传感器 |
| `manifest.json` | 声明 `config_flow: true`、依赖 `conversation, http`、`after_dependencies: [assist_pipeline]`、`integration_type: service`、`single_config_entry: true` |
| `translations/*.json` | config flow 与实体的本地化文案 |

### 7.2 关键类

#### `DSHClient`（dsh_client.py）
薄异步客户端，仅依赖 addon 桥接契约：

| 方法 | 说明 |
|------|------|
| `__init__(base_url, session, timeout=180, api_token)` | 构造；`_owned` 标记是否自持 session |
| `_headers()` | 配置了 token 则附加 `Authorization: Bearer` |
| `chat(message, conversation_id=None)` | `POST /api/chat`，超时抛 `DSHClientError`；401 给出 token 不匹配提示 |
| `status()` | `GET /api/status`，10s 超时，失败返回 `{online: False}` |
| `restart()` | `POST /api/restart`，30s 超时，返回是否 200 |
| `close()` | 仅当自持有 session 时关闭 |

#### `DSHClientError(Exception)`（dsh_client.py）
与 addon 通信失败的统一异常。

#### `DeepseekConversationAgent`（conversation.py）
继承 `conversation.ConversationEntity` + `AbstractConversationAgent`：

| 成员 | 说明 |
|------|------|
| `supported_languages` | 返回 `None`，支持所有语言 |
| `async_added_to_hass()` | 调用 `conversation.async_set_agent` 注册为 Assist 代理 |
| `async_process(user_input)` | 调 `client.chat(text, conversation_id)`；异常时返回致歉文案；`IntentResponse.async_set_speech` 回放 TTS |

#### `DSHRuntimeSensor`（sensor.py）
继承 `SensorEntity`，`async_update` 轮询 `client.status()` 得 `online/offline`，并把其余状态字段放入 `extra_state_attributes`，注册设备信息（`DeviceInfo`）。

---

## 8. 模块五：容器与构建配置

### 8.1 config.yaml（Add-on 清单）

| 字段 | 值 | 含义 |
|------|-----|------|
| `version` | `0.2.17` | addon 版本（与 Dockerfile `ARG BUILD_VERSION` 一致） |
| `slug` | `deepseek_harness` | 唯一标识 |
| `arch` | `aarch64, amd64` | 支持架构 |
| `ingress: true` / `ingress_port: 3080` | — | 启用 Ingress 到 3080 |
| `panel_icon` / `panel_title` | `mdi:whale` / `DSH Agent` | 侧边栏面板 |
| `hassio_api: true` | — | 允许调用 Supervisor API（重启/更新用） |
| `map: [config:rw]` | — | 持久化 `/config` |
| `options`/`schema` | `api_key, api_token, model, provider, base_url, workspace, preset, auto_start, api_port, ha_mcp_enabled, ha_mcp_url, ha_mcp_token` | 用户可配置项 |

### 8.2 Dockerfile

- 基础镜像 `node:22-bookworm-slim`（经 `ARG BUILD_FROM` 由 build.yaml 注入；用 Debian 因 node-pty 需 glibc）。
- 安装 `bash curl wget jq python3 build-essential`。
- 安装 `pnpm`（`npm install -g pnpm`），配置国内镜像源（`pnpm config --global set registry https://registry.npmmirror.com`），用于 DSH 插件管理。
- `npm install -g @deepseek-ai/dsh@next`（npmmirror 国内源），软链 `dsh`；该层为**只读层**，即"镜像内置版/离线兜底/回滚目标"。
- `COPY run.sh /run.sh`、`proxy.js /proxy.js`、`api_server.js /api_server.js`。
- `HEALTHCHECK`：同时探 `3081` 与 `3082/api/status`，任一不可达视为不健康。
- `CMD ["/run.sh"]`。

### 8.3 build.yaml

声明 `build_from` 为 `node:22-bookworm-slim`（aarch64/amd64），修正了原先与 Dockerfile 不一致的问题。

---

## 9. 依赖关系

### 9.1 维度一：模块间依赖链

```
HA 集成（Python）────────── HTTP/Bearer ──────────► 桥接 API (:3082)
deepseek_harness                                  api_server.js
     │                                                    │
     │                                       spawn(DSH_BIN --profile headless)
     ▼                                                    ▼
  Assist 对话 ◄─────────────────────────────► DSH Web UI (:3081) ◄─ HTTP/WS ─► proxy.js (:3080) ◄─ HA Ingress
     │                                                    ▲
     └──────────────── MCP（可选, 读/控设备）──────────────┘
```

### 9.2 维度二：运行时第三方便件依赖

| 依赖 | 用途 | 安装方式 |
|------|------|---------|
| `@deepseek-ai/dsh@next` | DSH 本体（rc.8） | Dockerfile `npm install -g @next`；可被 vendor 覆盖 |
| `pnpm` | DSH 插件管理（`dsh plugin` CLI 依赖） | Dockerfile `npm install -g pnpm` |
| `jq` | 解析 `/data/options.json` | Dockerfile `apt-get` |
| `python3` / `build-essential` | node-gyp 编译原生模块（node-pty） | Dockerfile `apt-get` |
| node 22 | 运行 proxy.js / api_server.js / DSH | 基础镜像自带 |
| **HA 环境** | Supervisor API（`hassio_api`）、Ingress、MCP Server、`assist_pipeline` | 运行宿主 |
| `transfer-encoding` / 头部规则 | — | 代理清洗，避免 aiohttp 400 |

### 9.3 维度三：npm registry 约定

- 全局（镜像构建）：`npm config set registry https://registry.npmmirror.com`
- 一键更新：`--registry` 显式传 npmmirror；可通过 `DSH_NPM_REGISTRY` 覆盖。

### 9.4 版本一致性（双轨）

由 [scripts/check-versions.sh](scripts/check-versions.sh) 校验，两轨**内部一致、跨轨不比较**：

| 轨道 | 文件 | 约束 |
|------|------|------|
| addon 轨 | `config.yaml` `version` == Dockerfile `ARG BUILD_VERSION` | 必须相等（`0.2.17`） |
| 集成轨 | `const.py` `VERSION` == `manifest.json` `version` | 必须相等（`0.2.0`） |

---

## 10. 项目运行方式

### 10.1 生产环境（HA 上运行）

1. **添加仓库**：HA → 加载项商店 → 三点菜单 → 仓库 → 添加 `https://github.com/C3H3-AI/ha-dsh-addon`。
2. **安装**：商店中出现 **DeepSeek Harness**，安装（支持 amd64/aarch64）。
3. **配置**（config.yaml 对应 options）：
   - `api_key`（必填，DeepSeek API Key）
   - `api_token`（强烈建议：桥接 API 共享密钥，**与集成侧填相同值**）
   - `model` / `provider` / `base_url` / `workspace`（建议持久化路径如 `/config`）
   - `ha_mcp_enabled` / `ha_mcp_url` / `ha_mcp_token`（可选，接 HA 设备）
4. **启动**：`startup: application`、`boot: auto`，侧边栏出现 **DSH Agent** 面板。

### 10.2 本地/开发运行

```bash
# 桥接 API 单独跑（需要 DSH_API_TOKEN）：
node deepseek_harness/api_server.js   # 需 env: DSH_API_TOKEN / DSH_BIN

# 契约测试（模拟 DSH headless）：
node tests/test_bridge_api.js

# 版本一致性：
bash scripts/check-versions.sh
```

### 10.3 运行时端口与数据

| 项 | 值 |
|----|-----|
| Ingress 端口 | 3080（容器内代理，不映射宿主机） |
| DSH Web | 127.0.0.1:3081 |
| 桥接 API | 3082（不映射宿主机） |
| 持久化数据 | `/data/dsh/`（sessions/settings/credentials/storages/vendor） |
| 工作区 | `/config`（SV mapped `config:rw`） |

> 卸载 addon 或变更 slug 会清空 `/data`，属预期行为；正常更新/ rebuild 保留。重要历史请先 `cp /data/dsh` 备份。

---

## 11. 测试与 CI

### 11.1 tests/

| 文件 | 说明 |
|------|------|
| `mock_dsh.js` | 模拟 `dsh --profile headless`：消息以 `slow:` 开头则延时返回，否则立刻回 `{text}` |
| `test_bridge_api.js` | 以子进程拉起 api_server，断言 19 项契约用例：状态、chat 的 401/错 token/正确/空消息、单飞锁 429、restart 401/500、update/status、常量时间 token 比较、未知端点 404 |
| 插件管理端点（手动验证） | `GET /api/plugin/list` 免鉴权 200 + 空列表；`POST /api/plugin/install\|uninstall` 无 token 401、缺 package 400、带 token 时 mock CLI 返回结果 |

### 11.2 CI（`.github/workflows/ci.yml`）四个任务

1. **lint**：`node --check` proxy.js/api_server.js；`py_compile` 集成 6 个 `.py`。
2. **version-consistency**：跑 `scripts/check-versions.sh`。
3. **contract-tests**：`node tests/test_bridge_api.js`。
4. **docker**：`docker buildx` 构建 amd64 镜像验证可构建。

---

## 12. 关键架构决策速查

| 决策 | 理由 |
|------|------|
| `DSH_HOME=/data/dsh` | Supervisor 自动持久化，杜绝 `/root` 在 rebuild 被清空导致的"会话/设置丢失" |
| DSH 仅回环 127.0.0.1:3081 + 代理接管 0.0.0.0:3080 | 安全（防 RCE 暴露）+ 回环与通配端口冲突规避 |
| 桥接 API Bearer 写操作 fail-closed | 防止容器内未授权触发 DSH 代码执行 / npm install / 容器重启 |
| 常量时间 token 比较 | 避免时序侧信道 |
| Chat 单轮 headless + 单飞锁 + 60s 超时 | DSH headless 是重进程且单轮 one-shot；控制类指令单轮即够 |
| `isLoopback` 双层伪装（前端脚本 + 后端 host.describe 改写 + client.js 源码改写） | 使设置持久化到后端而非 memory，保证 Ingress 下刷新不丢设置 |
| MCP 注入用 Home 级 `cordis.patch.yml`（顶层数组 + insert:） | rc.7 不支持 `--patch` 参数 |
| 一键更新：vendor.tmp 原子改名 + `.updated` 标记 + 容器重启 | npm 中断不损坏 vendor，保留回滚；addon 稳定壳只依赖 DSH 稳定契约，上游更新不重发 addon |
| 双轨版本号、跨轨不比较 | addon 壳与集成生命周期独立 |