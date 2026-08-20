# ha-dsh-addon + dsh-im 404 根因报告（v2 · 深度研究版）

> 本文件**取代并作废** `REPORT-dsh-im-404.md`（v1 的"rc.7 缺 typertGateway / 升级 rc.8 即可"归因**错误**，已被以下取证推翻）。
> 研究日期：2026-08-20。研究者：多啦。

---

## 0. 摘要（TL;DR）

- **现象**：addon 内给 DSH 装社区插件 `xmanrui/dsh-im` 后，设置页报 `transport failure for /weixin/connection.status: HTTP 404`。
- **真因**：**harness 与插件的版本错配（version skew）**，不是"rc.7 太旧"这种笼统说法。
  - addon 在**构建时**把 harness 冻结为 `latest`（当时 = `0.1.0-rc.7` 元包），但 npm caret 把子包（dsh-base / dsh-web-app / dsh-api-gateway / dsh-api-remotes）拉成了 **rc.8**——一套**混版本**的 harness。
  - dsh-im 的 host 插件按 **rc.8+ 的 host API** 写：用 `ctx.connection.rpc.handle('/weixin', …)` 注册 RPC，并用 `ctx.typertGateway` 做命令执行器。容器内装的是 **0.11.0**（装插件那一刻的 `latest`）；而 npm `latest` **当前已到 `0.13.0`**（2026-08-19 发布）。无论 0.11 还是 0.13，注册 `/weixin` 都硬依赖 host 端 `connection.rpc.handle`。
  - 在这套 rc.7 偏置的 harness 里，**提供 host 端 `connection.rpc.handle` 的那个服务没有/没接上**（web profile 的 `connection` row 只有 `dsh-client-connection`，没有 host 端连接 RPC 服务）。
  - 于是 dsh-im（**0.11 / 0.13 逻辑一致**）的 `installWeixinRpc` 一进来就 `throw TypeError('DSH Host Connection RPC is required')` → `/weixin` 路由**从未注册** → HTTP 404。
- **为什么"我们不行、裸 `dsh` 行"**：裸 `npx @deepseek-ai/dsh web` 是**同一时刻**把 harness + 插件从**同一个 latest 标签**一起装，版本天然对齐；你本机之所以行，是因为你装的是 **dsh-im 0.8.0**（旧版，不碰 `ctx.connection.rpc.handle` / `typertGateway`，用 `webServer` 直接挂路由），与 rc.7 兼容。
- **DSH 官方定位**（`README.md` 原文）：*“currently in developer preview and is iterating rapidly. THERE WILL BE COMPATIBILITY-BREAKING CHANGES.”* —— 冻结旧 harness + 浮动新插件 = 必然踩坑。

---

## 1. 研究方法（取证链）

1. **官方仓库源码**：`git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness`（rc.8 源码，84MB）读 `README.md` / `docs/architecture.md` / `packages/api/gateway/src/index.ts` / 各 bundle 的 `package.json` / `dsh-im` 的 `plugin-src`。
2. **HA 官方 addon 文档**：`developers.home-assistant.io/docs/apps/{configuration,communication}`。
3. **容器实机取证**（外网 `api.homediy.top` → 容器 `app_0393f39a_deepseek_harness`）：
   - `dsh --profile web --dump-config` 看组合树；
   - 读容器内 `dsh-im` 0.11 的 `plugin-src/host/{index,harness-command-executor,rpc-authority}.mjs`、`channels/weixin/{index,production,rpc}.mjs`（npm `latest` 现 0.13，逻辑一致）；
   - 读 `package.json`、`cordis.patch.yml`、harness 各包版本；
   - `docker logs` 取 404 与 `ERR_HTTP_HEADERS_SENT` 报错。

---

## 2. DeepSeek Harness 架构真相（纠正我之前的误解）

官方架构文档（`docs/architecture.md`）原话：**“Everything is a Plugin.”** 一个运行的 `dsh` 是这样拼出来的：

- **Profile**：存在 Harness Home（`DSH_HOME`）里的命名组合。列出它堆叠的 **bundles**、它装的 out-of-tree 插件、以及用户的 `cordis.patch.yml`。`web` 和 `headless` 是预置模板。
- **Bundle**：Cordis 配置行 + 挂载代码的发行格式。
- **分层装配顺序**（关键）：profile 里每个 bundle 按顺序 → profile 的 `cordis.patch.yml` → Home 级 patch（addon 写 `$DSH_HOME/cordis.patch.yml` 就是这一层）→ `--patch` 覆盖层。
- **服务依赖（inject）**：插件用 cordis 的 `inject: ['connection','credentials','webServer','typertGateway']` 声明它**需要的服务**。被依赖的服务由其他 bundle 用 `ctx.provide(...)` 提供；缺任何一个，该插件会被跳过或加载期抛错。

**关键事实（实锤）**：
- `ctx.typertGateway` 由 `@deepseek-ai/dsh-api-gateway` 提供（Host 服务，"Typert Host invocation gateway"）。
- `ctx.webServer` 由 `webserver` 包提供（node:http 路由注册表，web 传输插件在此注册自己的路由）。
- **`/weixin` 这类插件 RPC 路由，是靠 `ctx.connection.rpc.handle(channel, handler, opts)` 注册的**（见 dsh-im 0.11 `channels/weixin/rpc.mjs` 的 `installWeixinRpc`）。这是 **host 端连接 RPC 服务**的能力。

---

## 3. HA Addon 机制真相（纠正我之前"rc.7 vs rc.8"的跑偏）

- **`/data` 是始终挂载、可写、跨更新/重启持久化的卷**。addon 的 `DSH_HOME=/data/dsh` 因此能持久保存：会话、设置、凭据，以及**通过市场装的插件**（`/data/dsh/profiles/web/node_modules/@xmanrui/dsh-im`）。
- `map: config:rw` 挂到 `/config`（= `DSH_WORKSPACE`，也是持久卷）。
- Ingress 通过 `SUPERVISOR_TOKEN` 反向代理到 addon；addon 内部用 `node` TCP/HTTP 代理把 `0.0.0.0:3080` → `127.0.0.1:3081`（DSH 自身只监听 loopback，因安全限制禁止绑 0.0.0.0）。
- **结论**：插件装在 `/data/dsh` 下是**持久**的，重启/更新 addon 镜像不会丢。所以"升级 addon 镜像"不会重装插件，但会**换掉 harness 元包**——这正是版本错配的温床。

---

## 4. 根因（逐层钉死）

### 4.1 容器里的真实版本矩阵
```
dsh 元包                         = 0.1.0-rc.7   ← Dockerfile 构建时 npm install -g @deepseek-ai/dsh=latest 锁死
dsh-base / dsh-web-app          = 0.1.0-rc.8   ← npm caret 把子包拉成了 rc.8（混版本！）
dsh-api-gateway / dsh-api-remotes = 0.1.0-rc.8
@xmanrui/dsh-im（市场装）        = 0.11.0       ← 装插件时的 latest；npm latest 现已 0.13.0，均按 rc.8+ API 写
```

### 4.2 dsh-im 的硬性依赖（以容器内 0.11 源码为准，0.13 逻辑一致）
- `plugin-src/host/index.mjs`：`inject = ['connection','credentials','webServer','typertGateway']`
- 每个 channel（weixin/feishu/…）同样 inject 这四个。
- `harness-command-executor.mjs`：`const gateway = ctx?.typertGateway;` 且 `throw new TypeError('dsh-im requires a callable ctx.typertGateway')`。
- `channels/weixin/rpc.mjs` → `installWeixinRpc`：
  ```js
  if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== 'function')
    throw new TypeError('DSH Host Connection RPC is required');
  return ctx.connection.rpc.handle('/weixin', handler, { authority: resolveRpcAuthority(authority) });
  ```

### 4.3 组合树里缺什么（`dsh --profile web --dump-config` 实锤）
```
- id: connection
  name: '@deepseek-ai/dsh-client-connection'   ← 只有 CLIENT 端连接，没有 host 端 connection.rpc 服务
- id: typert          → @deepseek-ai/dsh-typert-registry
- id: typert-loader   → @deepseek-ai/dsh-typert-loader
- id: typert-gateway  → @deepseek-ai/dsh-api-gateway   ← typertGateway 其实"有"，所以**针对 typertGateway 升级 rc.8 无效**（推翻 v1）
```
**`ctx.typertGateway` 在 rc.7 这套里其实已经提供了**（推翻我 v1 的"缺 typertGateway"说法）。真正缺的是 **host 端 `connection.rpc.handle`**（dsh-im 注册 `/weixin` 所需的服务，对应 rc.8 源码 `HostConnectionRpc.handle`）。rc.7 偏置的 harness 没把它接进 web profile——**而 rc.8 源码确认 `HostConnectionRpc.handle` 已存在**（`packages/client/connection/src/rpc.ts:25-37`），所以**升级 harness 到 rc.8+ 方向正确**；但仍需在容器实测确认 rc.8 的 web profile 是否真把 host 端 `connection.rpc.handle` 装配进 `ctx.connection.rpc`。

### 4.4 因果链
```
dsh-im 0.11 host 插件 apply
  → createProductionController → createHarnessCommandExecutor(ctx) 需要 ctx.typertGateway（有，rc.8 提供）
  → installWeixinRpc(ctx,…) 需要 ctx.connection.rpc.handle
        ↑ 该服务在 rc.7 偏置 harness 的组合树里不存在
  → throw TypeError('DSH Host Connection RPC is required')
  → /weixin 路由从未注册
  → 设置页 GET /weixin/connection.status → HTTP 404
```
`docker logs` 印证：`[HTTP-…] response: 404` 反复出现。

---

## 5. 为什么"裸 dsh 行、我们不行"（精确版）

| 场景 | harness | dsh-im | 结果 |
|---|---|---|---|
| 你本机 `dsh web` | rc.7 元包 | **0.8.0**（你 clone 的旧版） | ✅ 0.8.0 不碰 `connection.rpc.handle` / `typertGateway`，用 `webServer` 直接挂路由，与 rc.7 兼容 |
| 任意机器 `npx @deepseek-ai/dsh web` + 市场装 dsh-im | 与插件**同时刻同 latest** | 最新（装时 0.11，现 npm 0.13） | ✅ 版本对齐，host API 匹配 |
| **本 addon** | **rc.7 元包 + rc.8 子包（混版本）** | **0.11（装时最新，现 npm 0.13）** | ❌ 0.11 要的 host `connection.rpc.handle` 在 rc.7 偏置组合里没接上 |

**核心矛盾**：addon 把 harness **冻结在构建时刻**，而插件是**运行时从市场浮动到最新**。DSH 又是"破坏性变更频繁"的开发者预览版 → 这两轨必然漂移。

---

## 6. 我之前的两次错误归因（诚实记录）

1. **v1 报告说"rc.7 缺 typertGateway，升级 rc.8 即可"** —— 部分错。rc.7 的 web profile 经 `dsh-base` **已经提供** `typertGateway`（dump-config 实锤 `typert-gateway` row 在），所以**针对 typertGateway 升级 rc.8 无效**。但 v1 的"升级 rc.8"方向对另一件事成立：rc.8 源码确认 `HostConnectionRpc.handle`（即 dsh-im 注册的 `ctx.connection.rpc.handle`）已存在，而 rc.7 偏置 harness 缺它——**升级 harness 到 rc.8+ 是解决 `/weixin` 404 的正确方向**。这是 v2 相对 v1 的修正点。
2. **把 `D:\ai-hub\DSH` 当成 deepseek-harness 源码** —— 错。那是 `xmanrui/dsh-im` 的 clone（upstream 指向 dsh-im.git）。我之前读的那个 `package.json` 是 dsh-im 的，不是 harness 的。

---

## 7. 附带发现的 Bug（与 404 无关但必须修）

### Bug A：run.sh 的 rpcAuthority patch 静默失效（缩进不匹配）
`run.sh` L207-228 想给 dsh-im 注入 `rpcAuthority: trusted-host`，但：
```js
content.replace("name: '@xmanrui/dsh-im'", "name: '@xmanrui/dsh-im'\n      config:\n        rpcAuthority: trusted-host");
```
实际 dsh-im 的 `cordis.patch.yml` 里那一行是 **缩进 6 格** 的 `      name: '@xmanrui/dsh-im'`，无缩进的 replace 目标**匹配不到** → 替换静默 no-op → `rpcAuthority` 从未注入。
- 影响：dsh-im 默认 `loopback` 权威。从浏览器经 addon 代理（127.0.0.1，属 loopback）调用其实 OK；但一旦走 HA Ingress（来源非 loopback）就会 403。**这是潜在雷，且与 404 是两回事**，应修（用正确的 YAML 节点插入，而非字符串 replace）。
- 补充（2026-08-20 核实 dsh-im 0.13 文档）：**IM 管理 RPC 默认仅接受回环（loopback）浏览器**；若 Web profile 在受信任局域网内对外提供服务，须在 profile 的 `cordis.patch.yml` 显式配 `rpcAuthority: trusted-host`。addon 通过 proxy 把 DSH 暴露到非 loopback 的 HA 网络，因此**即便 `/weixin` 路由注册成功，也必须配 `trusted-host` 否则会因 authority 拒绝而失败**。这已从"潜在雷"升级为**修复后的必需步骤**——与之前的 404（路由未注册）是先后两道关。

### Bug B：proxy.js 的 `ERR_HTTP_HEADERS_SENT`
`docker logs` 出现 `Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client`。addon 的 HTTP 代理在 404 路径上二次写 header。需排查 proxy.js 的响应写回逻辑（与 404 同源但独立）。

---

## 8. 技术方案（遵循"不逐个改插件、让 addon 的 dsh 能跑所有插件"原则）

### 根因对策：让 harness 与插件**版本对齐**
插件永远浮动到最新（市场行为，不可控、也不该控），所以**必须由 addon 保证 harness 跟上插件时代**。三条路：

#### ✅ 方案 A（推荐）：用 addon 已有的 vendor 覆盖机制，把 harness 升级通道化（addon 层、可逆、不改任何插件）
- run.sh **已经**优先加载 `/data/dsh/vendor` 下的 harness（`VENDOR_DSH_BIN` 优先于镜像内置）。
- 增加**受控的"更新 harness"动作**（option 或按钮）：在容器内 `npm install @deepseek-ai/dsh@<对齐版本> --prefix /data/dsh/vendor`，写 `.updated` 标记，重启 addon 即生效。
- 这样 harness 能独立于镜像与插件保持同步；插件市场装什么都跑得起来 —— **正好满足你的原则**。
- 风险：dev-preview 破坏性变更仍可能让某次对齐失败 → 因此用 vendor 而非改 Dockerfile，失败删 `/data/dsh/vendor` 即回滚。

#### 方案 B（次选）：Dockerfile 直接钉 `next`/`0.1.0-rc.8`
- `npm install -g @deepseek-ai/dsh@next`，重新构建镜像。harness 随镜像走，环境最干净。
- 代价：每次 DSH 发版都得重构建镜像才能跟上；且 `next` 也是预览版，需评估稳定性。

#### ❌ 方案 C（拒绝）：改 dsh-im / 写兼容 shim
- 违反你明确的原则（"改 dsh-im 肯定不行，我们不能遇到一个插件修改一个插件"）。且 dev-preview 下 shim 极易随下个破坏性变更再碎。

### 必须同步修的（不论走 A 还是 B）
- **Bug A**：把 rpcAuthority 注入改成正确的 YAML 操作（dsh-im 0.13+ 文档已明示支持 `rpcAuthority: trusted-host` 配置），确保 `trusted-host` 能力可用，去掉脆弱的字符串 replace。
- **Bug B**：修 proxy.js 的二次写 header。

### 验证步骤（可逆，需你点头才做）
1. 容器内 `npm install @deepseek-ai/dsh@next --prefix /data/dsh/vendor`（不动镜像、不动插件）。
2. 重启 addon，等 DSH 加载。
3. 打开 dsh-im 设置页，确认 `/weixin/connection.status` 不再 404。
4. 若仍 404 → 回滚：删 `/data/dsh/vendor`，重启即回 rc.7 状态。

---

## 9. 待你确认
- 是否同意**方案 A（vendor 通道化 harness 升级）**作为根因对策？
- 是否允许我先做**可逆的 vendor 升级验证**（第 9 节步骤 1-4）来一锤定音确认根因？
- Bug A / Bug B 是否一并修（独立于版本问题）？
