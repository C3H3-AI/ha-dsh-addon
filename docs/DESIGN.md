# DeepSeek Harness HA Addon — 完整设计方案

> 项目：`ha-dsh-addon`
> 仓库：`https://github.com/C3H3-AI/ha-dsh-addon`
> 维护者：C3H3-AI
> 本文档整合了 DeepSeek Harness Home Assistant Addon 的整体架构、所有关键修复的设计决策，以及「Web 一键更新」功能的实施方案。

---

## 1. 项目概述

将 **DeepSeek Harness（DSH）** —— 上游开源的 AI Agent 运行框架（"一切皆插件"）—— 封装为 Home Assistant 的 Addon，提供：

- HA Ingress 内的 DSH Web UI（聊天 / Agent）
- 桥接 API（供 HA 自定义集成 `deepseek_harness` 调用，做智能助手）
- 可选接入 HA 原生 MCP Server，让 DSH 控制家里的设备

| 属性 | 值 |
|------|-----|
| Addon 版本 | `0.2.16`（配套集成 `deepseek_harness` 为 `0.2.0`） |
| DSH 依赖 | `@deepseek-ai/dsh@next`（rc.8，Dockerfile 固定版本，用户可通过一键更新升级） |
| Bridge API 鉴权 | 共享密钥 `api_token`（`Bearer`，写操作必带，fail-closed） |
| Web UI 端口 | Ingress 3080（对外）→ DSH 127.0.0.1:3081（内部） |
| 桥接 API 端口 | 3082 |
| 插件管理 | `pnpm` + `dsh plugin` CLI + 桥接 API 插件端点 + 浏览器 UI 按钮 |
| 架构 | aarch64 / amd64 |

---

## 2. 总体架构

```
┌─────────────────────────── 容器内 ───────────────────────────┐
│                                                              │
│   [HA Ingress] ──► [HTTP 代理 0.0.0.0:3080]                  │
│                          │  (注入脚本/改写 host.describe)     │
│                          ▼                                 │
│              [DSH Web UI 127.0.0.1:3081]                    │
│                   │      ▲                                  │
│                   │      │ WebSocket (upgrade)              │
│                   ▼      │                                 │
│   [桥接 API 0.0.0.0:3082]──► DSH headless（单轮 one-shot）     │
│       ├ GET  /api/status          (只读,放行)                    │
│       ├ POST /api/chat            (需 Bearer token)             │
│       ├ POST /api/restart         (需 Bearer token)             │
│       ├ GET  /api/update/status   (需 Bearer token)             │
│       ├ POST /api/update          (需 Bearer token, 一键更新)   │
│       ├ GET  /api/plugin/list     (只读,放行)                    │
│       ├ POST /api/plugin/install  (需 Bearer token, 插件安装)   │
│       └ POST /api/plugin/uninstall(需 Bearer token, 插件卸载)   │
│                                                              │
│                          ┌──────────────────────┐             │
│                          │  HTTP 代理 0.0.0.0:3080 │             │
│                          │  ┌──────────────────┐ │             │
│                          │  │ /__dsh_update*  →│ │             │
│                          │  │   bridge API     │ │             │
│                          │  ├──────────────────┤ │             │
│                          │  │ /__dsh_plugin*  →│ │             │
│                          │  │   bridge API     │ │             │
│                          │  └──────────────────┘ │             │
│                          └──────────┬───────────┘             │
│                                                              │
│   持久化目录 /data/dsh/                                       │
│     ├ settings.yaml          (模型/提供商配置)                 │
│     ├ cordis.patch.yml        (MCP 插件注入)                  │
│     ├ sessions/  jobs?/       (会话/任务数据)                  │
│     ├ storages/              (工作区/存储元数据)               │
│     └ vendor/                (web 一键更新的新版 DSH)          │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 四个组件

| 组件 | 文件 | 职责 |
|------|------|------|
| 启动脚本 | `run.sh` | 读配置、生成 DSH 配置、启动 DSH + 注入生产代理 |
| HTTP/WS 代理 | `deepseek_harness/proxy.js`（独立文件，Dockerfile `COPY` 至 `/proxy.js`，run.sh 以 `node /proxy.js` 启动）| 处理 Ingress 前缀、重写 HTML/JS、改写 API 响应、中转更新/插件管理请求 |
| 桥接 API | `api_server.js` | 面向 HA 自定义集成的稳定契约 + 一键更新 + 插件管理 |
| 插件管理 | proxy.js（浏览器 UI） + api_server.js（管理 API） | 浏览器侧安装/卸载 DSH 插件（转发 `dsh plugin` CLI） |

---

## 3. 关键设计点 1 — DSH 启动与持久化

### 3.1 DSH_HOME 必须指向持久化目录
- DSH 的**所有用户数据**都存放在 `$DSH_HOME` 下：
  - 会话日志 `sessions/*.jsonl.zstd`
  - 设置 `settings.yaml`
  - 凭据 `.credentials.yaml`
  - 工作区/存储元数据 `storages/`
- **教训**：早期`DSH_HOME`指向容器普通目录 `/root/.dsh`，`/root` 在 addon 重建时被清空，导致对话记录、设置全部丢失。
- **方案**：`export DSH_HOME="/data/dsh"`（HA Supervisor 自动持久化的 addon 数据目录，容器重建不丢）。

### 3.2 工作区路径：默认 `/config`，注意手动覆盖

- `run.sh` 第 107–113 行显式将 `DSH_WORKSPACE` 默认设为 `/config`（HA 配置目录，经 `map: config:rw` 持久化）。
- 用户可通过 addon 配置项 `workspace` 手动覆盖；若设为非持久化目录（如 `/root/xxx`），容器重建后该目录内容丢失。
- **注意**：DSH 的 Workspace API 允许用户在 UI 中创建新的 workspace，其路径用户自行填写。`/root/test` 即用户手动创建的结果，并非 addon 默认行为。建议用户创建 workspace 时选择持久化路径。

### 3.3 DSH 禁止绑定 0.0.0.0
- 安全原因：绑定公网会暴露**远程代码执行**能力。
- 方案：DSH 监听 `127.0.0.1:3081`，再由 Node.js 代理监听 `0.0.0.0:3080` 转发到 3081。DSH 与代理端口必须不同，否则 `0.0.0.0:3080` 与回环地址冲突（EADDRINUSE）。

### 3.4 配置来源
- 优先读 `/data/options.json`（Supervisor 挂载）；`[ -f ]` 判断可能因 bind mount 显示为目录，故加 `elif $HASSIO_OPTIONS` 与 else 兜底。
- 首次启动若 `settings.yaml` 不存在，则由 run.sh 根据 options 生成（模型 + API Key）。

---

## 4. 数据持久化调查与根因分析

### 4.1 关键事实（基于 DSH 实际行为）

| 事实 | 证据 |
|------|------|
| `DSH_HOME=/data/dsh` | run.sh 第 79 行显式定义，注释声明所有用户数据在 `$DSH_HOME` 下 |
| 工作区默认 `/config` | run.sh 第 107–113 行：`else export DSH_WORKSPACE="/config"` |
| `map: config:rw` 持久化 `/config` | config.yaml 第 18 行 |
| HA Supervisor 的 `/data` 在 addon **更新**时必定保留 | 这是 Supervisor 的固有行为——更新（包括 rebuild）不改 `/data` 卷；只有卸载重装或 slug 变更才会清空 |
| 设置/凭据在 rebuild 后幸存 | 多次验证：`settings.yaml`、`credentials` 在 rebuild 后完好 |
| 浏览器端 `isLoopback=false` 时设置退回 memory 模式 | 这是 isLoopback 伪装机制要解决的根本问题（§6） |

### 4.2 根因判断：会话数据丢失的几种可能

DSH 的 `/data` 卷在 addon 更新时**必定保留**，因此"Supervisor 重建新 volume 导致 sessions 丢失"不成立。会话丢失的真正原因可能是：

1. **工作区关联丢失**：会话文件 `sessions/*.jsonl.zstd` 仍在磁盘，但 DSH 的工作区元数据（`storages/`）丢失或工作区路径变更，导致旧会话在 UI 不可见
2. **浏览器端状态丢失**：DSH Web UI 的会话列表/索引在浏览器 localStorage/IndexedDB（客户端），`isLoopback` 退化到 memory 模式时刷新即丢，UI 显示为空，但服务端会话文件仍在
3. **DSH 版本升级改会话格式**：新 DSH 版本不兼容旧会话格式，启动时自动清理
4. **用户卸载重装 addon**：卸载 addon 会清空 `/data` 卷，属预期行为

### 4.3 验证方法

- 确认 `/data/dsh/sessions/` 下是否有旧会话文件（SSH 进容器检查）
- 核实那次"丢失"是 addon 更新还是卸载重装
- 检查浏览器 localStorage 是否清空

### 4.4 保护措施

- **文档提醒**：README 注明"卸载 addon 会清空 `/data`，需先备份"（已添加）
- **isLoopback 退化日志**：代理注入 miss 时输出 WARNING（§6.4），运维可第一时间发现持久化退化
- **待验证**：通过 SSH 实锤确认 DSH 会话文件实际落点、工作区元数据存储方式后，再决定是否需要运行时保护措施

---

## 5. 关键设计点 2 — HA MCP 注入（A 底座：让 DSH 控设备）

- 早期用 `--patch` 命令行参数注入 MCP 插件 → **失败**：DSH rc.7 不支持 `--patch`。
- **方案**：写入 **Home 级 patch** `/data/dsh/cordis.patch.yml`，DSH 装配系统会在最后一层自动加载。
- **格式要求**：必须是**顶层 YAML 数组**，用 `- insert:` 语法注入插件行。
- 插件名必须是 `@deepseek-ai/dsh-mcp-client`（用过错误的 `mcp-client-ha` 导致 `Cannot find package`）。

```yaml
- insert:
    - id: ha-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        serverName: ha
        url: "http://127.0.0.1:3081/api/webhook/..."
        headers:
          Authorization: "Bearer <token>"
        failOnStartupError: false
```

---

## 6. 关键设计点 3 — Ingress 下的 isLoopback 伪装

### 6.1 问题
DSH 前端通过 `connection.isLoopback` 决定设置的持久化方式：
- `isLoopback=true`  → `persistence="host"` → 设置通过 RPC 存到后端 `settings.yaml`（**能保存**）
- `isLoopback=false` → `persistence="memory"` → 弹窗状态/语言/所有设置**刷新即丢**

HA Ingress 下 hostname 是外部域名（如 `api.homediy.top`），`isLoopbackHostname()` 判定为非回环 → 一切设保存不住。

### 6.2 双层伪装（proxy 校验兜底）
1. **前端**：注入脚本覆盖 `Location.prototype.hostname` 返回 `127.0.0.1`。
   - 注意不覆盖 `Location.prototype`（Chromium 不可配置）而覆盖 `Location.prototype.hostname`（可配置 getter），同时覆盖 `host`。
2. **后端**：拦截 `/api/host.describe` 响应，递归把所有 `hostname` 字段改写为 `127.0.0.1`。因为 DSH 后端以 host.describe 返回的 hostname 判断 isLoopback。

### 6.3 代理改写 client.js
- 针对 `dsh-client-connection` 模块的 `client.js`，用正则把 `isLoopback: (...)` 直接替换为 `isLoopback: true`。
- 必须处理**带查询参数**的 URL（如 `?rev=xxx`）：先 `targetPath.split('?')[0]` 再匹配 `endsWith(...)`。
- 压缩/非压缩均需兜底处理。

### 6.4 注入失败降级日志（防静默失效）
针对 `isLoopback` 替换与 `host.describe` 改写，代理在执行后会校验是否真正命中目标并**记录 WARNING 日志**（如 `proxy isLoopback injection miss` / `proxy host.describe rewrite miss`）。
- **动机**：这两项注入依赖 DSH rc 版的内部字符串/结构，上游更新可能改掉它们而让 `replace` 静默不命中 → 设置回退到 `memory` 模式（刷新即丢）。原本这是最大风险点（见评审 §最大风险）。
- **对策**：注入不再"静默"，命中失败时显式告警，运维可第一时间从 addon 日志发现持久化退化，而不是等用户报"设置丢了"。

---

## 7. 关键设计点 4 — Ingress 路径与移动端布局

### 7.1 Ingress 路径重写（SPA 绝对路径问题）
- HA Ingress 带前缀 `/api/hassio_ingress/<token>/`，DSH SPA 使用绝对路径 `/plugins/...` 会加载 404。
- **方案**：注入 `<base href="<ingress>/">`，并重写 HTML 中 `src/href`、`"url":"/plugins/` 为带前缀路径；同时注入脚本 patch `fetch` 与 `WebSocket`，把 `/api/...` 重写为 `ORIGIN + BASE + path`。
- 代理转发时把 `X-Ingress-Path` 前缀从 `targetPath` 中剔除，避免 DSH 收到带前缀路径返回 404。

### 7.2 移动端布局
- 不再强改 DSH 三栏（sidebarCol/centerCol/detailsCol）的压缩布局（会破坏界面）。
- 仅做**最小修复**：`@media (max-width:768px)` 下确保 dialog/modal 全屏可见、表单元素 `font-size:16px`、底部 `safe-area-inset-bottom` 适配，避免对话框被遮挡/不可见。

### 7.3 兼容性 polyfill
- 部分 WebView 缺 `crypto.randomUUID` → 注入 polyfill（用 `Math.random` 生成 UUID）。

### 7.4 localStorage 诊断
- 注入脚本输出 `[storage]` 日志，列出 localStorage keys 及会话/对话数据是否存在，便于排查持久化问题。

---

## 8. 关键设计点 5 — 版本管理与发布机制（HA Supervisor 约定）

### 8.1 为什么"改了版本号还得推 git + 重建"
- HA Supervisor 从 **git 仓库的已提交版本**构建 addon 镜像，而非工作目录的改动。
- 只改本地文件不提交 → 重启后回到旧代码（版本回退）。
- **必须**：`git add + git commit + git push` 都把新代码带到远端，让 Supervisor 读取最新源码构建。

### 8.2 双轨版本号（addon 壳 与 配套集成 独立版本）
addon 壳与配套集成 `deepseek_harness` 采用**独立版本轨道**（见 §1）：

| 轨道 | 文件 | 约束 |
|------|------|------|
| addon 轨 | `config.yaml` 的 `version` + `Dockerfile` 的 `ARG BUILD_VERSION` / `io.hass.version` label | 二者必须相等（当前 `0.2.16`） |
| 集成轨 | `custom_components/deepseek_harness/const.py` 的 `VERSION` + `manifest.json` 的 `version` | 二者必须相等（当前 `0.2.0`） |

- **两轨不跨轨比较**：addon 0.2.16 ≠ 集成 0.2.0 是**正确且既定**的设计，并非版本漂移。
- （构建时）Supervisor 的 `apps.json` 缓存仍需随 addon 轨版本同步更新并重启 Supervisor 刷新（见下方"Supervisor apps.json 缓存"说明）。
- 仓库内置 `scripts/check-versions.sh` 在 CI 中校验**双轨各自一致**，避免曾出现的 `const.py`(0.1.0) 与 `manifest.json`(0.2.0) 漂移类问题。

- Supervisor 有 `apps.json` 缓存旧版本号 → 需同步更新该文件并重启 Supervisor 刷新，否则 HA 界面不识别新版本（曾出现显示 0.2.12 实为 0.2.13）。

### 8.3 发布 Release 的教训
- 已发布的 Release 提交信息错误时，**不要 force-push 重写 tag**，而应递增 minor 版本（如 0.2.13 → 0.2.14），否则破坏 HACS 用户缓存。

### 8.4 DSH 升级的现状
- Dockerfile 用 `npm install -g @deepseek-ai/dsh@next` → 装 rc.8（当前 `next` tag）。
- 用户可通过 Web UI 一键更新按钮随时切换到 `latest` 或 `next` 通道。
- DSH 在镜像只读层，`npm update -g` 会破坏包 → 需要"Web 一键更新"方案（见 §9）。
- **设计动机**：DSH 更新快（测试期），若每次上游发 rc 都要维护者重新构建 addon 镜像，成本不可接受。正确姿势是 addon 壳稳定、DSH 本体由用户按需一键更新到上游（见 §9.0 更新边界原则）。

### 8.5 DSH 会话能力的关键事实（影响架构决策）
- **headless profile（Assist 通道）是单轮 one-shot**：`dsh-headless/lib/index.js` 每次 `sessionId: SessionId(\`session-${randomUUID()}\`)`，每次新建随机会话、无 CLI 参数（`--session`/`--resume`/`--continue`）可复用。
- **DSH 会话恢复能力真实存在，但不在 headless CLI**：`dsh-agent-loop/lib/index.js` L1256 `resume()` 完全实现（仅当未配置 `sessionPersistence` 才抛错），`dsh-agent.resume()`（L556）为 API 层入口。它由 web/前端协议、`dsh-subagent` 等调用。
- **架构决策**：Assist 通道维持 headless **单轮**（控制类指令如"开灯/查天气"单轮即够，多轮收益集中在连续对话场景）。不采用 WS relay（复刻 DSH web 私有帧协议成本高、违反"不碰易变内部"铁律、与 §9 一键更新冲突）。若未来连续对话成刚需，优先探索 addon 侧直接调用 `agent-loop.resume()`（host 稳定层，非 web 私有协议），并确认 DSH 是否暴露可编程 host API。

---

## 9. 待实现功能 — Web 一键更新

### 9.0 设计动机与更新边界（核心原则）

> **DSH 处于测试期（rc.x），更新频繁。本功能的目标是：让用户自主把 DSH 升到上游最新版，无需维护者跟随每个 rc 重新发布 addon。**

| 层 | 内容 | 更新方式 | 频率 |
|----|------|----------|------|
| **addon 稳定壳** | Dockerfile / config.yaml / run.sh / api_server.js / 代理 | 仅维护者发新版 | 低频（仅上游接口重大变化时） |
| **DSH 可变层** | `@deepseek-ai/dsh` 本体（rc.7 → rc.8 → ...） | **用户一键更新到上游**，无需维护者干预 | 随上游（高频） |

**稳定契约边界**：
- addon 壳**只依赖 DSH 的稳定契约**：headless CLI（`argv + stdout`）、`--profile` 启动参数。
- 上游保持该契约不变 → **addon 永不重发**，用户一键更新即可跟随最新 rc。
- **仅当上游接口发生破坏性变化**（headless CLI 参数、web 协议、MCP 注入机制等）时，才需要维护者重新设计 addon 并发布新版本。

> 这一原则与 §8.5 的架构决策一致：Assist 通道走 headless CLI（稳定契约）而非 web 私有协议（易变），正是为了让"addon 稳定壳"成立——上游怎么更新，addon 都不受影响。

### 9.1 目标
在 DSH Web 界面提供「检查更新 / 一键更新」，使用户**不经 HA 商店、不等待维护者发版**即可将 DSH 升级到上游最新（当前目标 rc.8，通道见 §9.5）。

### 9.2 核心约束
- DSH 本体在**镜像只读层**，重启还原 → 「更新本体」= 把新版 DSH 装到**持久化目录** `/data/dsh/vendor` + run.sh 启动时优先加载 + 优雅重启容器。

### 9.3 三层架构
```
[DSH Web] 注入更新按钮（复用 run.sh HTML 注入机制）
   ▼
[bridge API] GET/POST /api/update* → npm 装新版到 /data/dsh/vendor + 写标记
   ▼
[run.sh] 启动时优先加载 /data/dsh/vendor 的新版 DSH
```

### 9.4 改动点
| 文件 | 改动 |
|------|------|
| `run.sh` | 增加"确定 DSH 运行路径"：`vendor` 存在则优先用；否则回退镜像内置版 |
| `run.sh` | 新增注入脚本 `updateUiScript`（浮动更新按钮 + 状态/版本展示） |
| `api_server.js` | 新增 `GET /api/update/status`、`POST /api/update`（npm view + 后台 install 到 vendor + 原子改名 + 写标记重启） |
| `Dockerfile` | 保留镜像内置 DSH 作离线兜底；可选预装 vendor |

**安全要求**：`/api/update*` 属于高危写操作，必须走与 `/api/chat` 相同的 `Bearer` token 鉴权（fail-closed），防止容器网络内未授权触发任意 npm install / 容器重启。

### 9.5 版本通道
- UI 展示 `latest`（rc.7 / 稳定）与 `next`（rc.8 / 预发布）两个通道供选；默认「一键更新」指向 `next` 以达成 rc.8。

### 9.6 风险与对策
| 风险 | 对策 |
|------|------|
| npm 中断损坏 vendor | 先装 `vendor.tmp` 成功后原子改名 |
| 新版破坏会话 | 会话在 `/data/dsh/sessions` 不删除；保留旧 vendor 供回滚 |
| 低性能设备安装慢 | 复用 npmmirror 国内源 |
| 更新中崩溃 | 容器重启后 run.sh 回退镜像内置版兜底 |

### 9.7 热重启策略（推荐）
- **写标记 + 重启整个 addon 容器**（原子、稳），避免进程级热更造成脏状态。
- API 内已有 `handleRestart`（走 `/addons/{slug}/restart`），可复用。

### 9.8 插件管理实现

插件管理将 DSH 的 `dsh plugin` CLI 包装为 HTTP API，通过 proxy 注入的 UI 按钮在浏览器中直接操作。

#### 架构

```
[浏览器] 绿色「插件」按钮 → /__dsh_plugin/plugin/list|install|uninstall
   ▼ (proxy 注入 Bearer token)
[HTTP 代理 0.0.0.0:3080] → /api/plugin/* → 桥接 API
   ▼
[桥接 API] → spawn('node', [DSH_BIN, 'plugin', '--profile', 'web', ...])
   ▼
[dsh plugin CLI] → spawnSync('pnpm', [...], { cwd: $DSH_HOME/profiles/web })
   ▼
[pnpm] → 安装到 profile node_modules → reconcile bundles
```

#### 桥接 API 端点

| 端点 | 方法 | 鉴权 | 功能 |
|------|------|------|------|
| `/api/plugin/list` | GET | 免鉴权（只读） | 读取 `$DSH_HOME/profiles/web/package.json` 返回已安装插件列表 |
| `/api/plugin/install` | POST | Bearer token | 转发 `dsh plugin --profile web add <pkg>`，安装后需重启容器生效 |
| `/api/plugin/uninstall` | POST | Bearer token | 转发 `dsh plugin --profile web remove <pkg>`，卸载后需重启容器生效 |

#### HTTP 代理插件管理 relay

- URL 模式：`/__dsh_plugin/*` → 桥接 API `/api/plugin/*`
- 安全约束：与更新 relay 相同，仅允许 Ingress 来源（`x-ingress-path` 头部必须存在）防止容器内未授权访问
- token 注入：proxy 自动注入 `Authorization: Bearer <token>`，浏览器端无需持有密钥

#### 前提条件

- pnpm 必须在容器 PATH 中（Dockerfile 已安装 `npm install -g pnpm`）
- pnpm 配置国内镜像源（`pnpm config --global set registry https://registry.npmmirror.com`）
- 插件安装过程较慢（pnpm 下载依赖），API 超时设置为 120 秒

#### 浏览器 UI

- 浮动绿色「插件」按钮（位于一键更新按钮上方，`right:16px; bottom:56px`）
- 点击展开面板，显示已安装插件列表（每项带删除按钮）
- 输入框支持回车键快速安装
- 面板底部提示"安装/卸载后需重启容器生效"
- 安全：删除操作有 `confirm()` 确认对话框

#### 与 DSH 内置插件市场的关系

- 本方案是**独立于** DSH Web UI 原生插件市场的另一套入口
- 原生插件市场是否可用取决于 DSH 后端是否在进程内直接调用 `dsh plugin` CLI（需 pnpm 在 PATH 中）
- 两套方案共用同一套 profile 目录和 pnpm 配置，安装结果互通

#### 改动点

| 文件 | 改动 |
|------|------|
| `Dockerfile` | 新增 `npm install -g pnpm` + `pnpm config --global set registry ...` |
| `Dockerfile` | DSH 版本从 `@0.1.0-rc.7` 改为 `@next`（rc.8，修复 bundle 结构问题） |
| `api_server.js` | 新增 `runPluginCommand()` + `handlePluginInstall/uninstall/list()` |
| `proxy.js` | 新增 `/__dsh_plugin*` relay（与更新 relay 同模式） |
| `proxy.js` | 新增 `pluginUiScript`（浮动按钮 + 面板 + 安装/卸载逻辑） |

---

## 10. 已修复的问题 — build.yaml 与 Dockerfile 对齐

- 原 `build.yaml` 的 `build_from` 声明 `node:22-alpine`，而 `Dockerfile` 写死为 `node:22-bookworm-slim` 且未引用 `BUILD_FROM`，导致 build_from 被静默忽略、且假设性的 Alpine 基准与注释意图（用 Debian 因 node-pty 的 glibc）相矛盾。
- **修复**：
  - `build.yaml` 的 `build_from` 改为 `node:22-bookworm-slim`（aarch64 / amd64）
  - `Dockerfile` 增加 `ARG BUILD_FROM` 并在 `FROM ${BUILD_FROM}` 引用，使 Supervisor 传入的 build_from 真正生效。

---

## 11. 测试与 CI

### 11.1 契约测试（固化进仓库，非 `.scratch/`）
桥接 API 的契约测试位于 `tests/`，随仓库提交、在 CI 中执行：

| 文件 | 用途 |
|------|------|
| `tests/mock_dsh.js` | 模拟 DSH headless 进程（stdout 输出 `{text:...}`），供桥接 API 调用 |
| `tests/test_bridge_api.js` | 验证 19 项契约用例：`/api/chat\|status\|restart\|update*` 的鉴权（常量时间比较 + 未配 token 即 401 fail-closed）、单飞并发锁、60s 超时、update 双重闸 |
| 插件管理端点（手动验证） | `GET /api/plugin/list`（免鉴权 200 + 空列表）、`POST /api/plugin/install\|uninstall`（无 token 401、缺 package 400、带 token 时 mock CLI 返回 502/200）|

> 调试期的临时脚本（`test_api*.js` / `test_proxy*.js` / `debug/*`）仍在 `.scratch/`（gitignore），不进入仓库；正式回归走 `tests/`。

### 11.2 CI（GitHub Actions）
`.github/workflows/ci.yml` 包含四个任务：
1. **lint**：`node --check` 校验 `proxy.js` / `api_server.js`；`py_compile` 校验集成 `.py`。
2. **version-consistency**：`scripts/check-versions.sh` 校验双轨版本号一致（见 §8.2）。
3. **contract-test**：`node tests/test_bridge_api.js`，断言 19 项契约用例通过。
4. **docker**：`docker build` 验证 addon 镜像可构建。

### 11.3 子进程自愈（run.sh）
- DSH web 主进程死亡 → run.sh 退出 → Supervisor 重启整个 addon（干净）。
- 仅 proxy / bridge 子进程死亡、DSH 仍存活 → run.sh 在 `while kill -0 $DSH_PID` 循环内原地 respawn，避免"半残状态"（详见 run.sh 第 248–262 行）。

---

## 12. 调试脚本（开发辅助，未提交）

| 脚本 | 用途 |
|------|------|
| `debug/dsh-client.js`, `debug/plugin-dsh-web.js` | 分析 DSH 客户端/插件装配行为 |
| `debug/check_dsh.sh` | 检查容器 DSH_HOME、持久化目录、settings.yaml |