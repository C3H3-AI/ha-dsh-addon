# ha-dsh-addon + dsh-im 接入 404 根因分析报告

> 生成时间：2026-08-20
> 项目：`D:\ai-hub\integrations\ha-dsh-addon`（封装 DeepSeek Harness / DSH 的 HA Addon）
> 结论状态：**根因已实锤，修复方案待用户批准**

---

## 1. TL;DR（太长不看）

- **现象**：在 addon 内给 DSH 安装社区插件 `xmanrui/dsh-im`（IM 聊天机器人接入）后，设置页报 `transport failure for /weixin/connection.status: HTTP 404`。
- **根因（已 SSH 实锤）**：不是我们改坏了插件，也不是 loopback 鉴权问题，而是 **addon 锁定的 DSH 版本太旧**——Dockerfile 默认装 `latest`（= rc.7），缺 dsh-im 0.11 依赖的 `typertGateway` / `webServer` 这两个 DSH 服务。cordis 因依赖缺失静默跳过了 dsh-im 的 host 插件，导致 `/weixin` RPC 根本没注册 → 404。
- **本质**：原版 DSH 环境是 `next`（rc.8），版本新、依赖齐全，所以能跑；addon 锁定 rc.7 所以缺依赖。
- **修复**：把 addon 内的 DSH 升级到 `next`（rc.8）。
- **现状**：所有代码/文档改动**均未提交**（遵循"先确认再发布"铁律）。

---

## 2. 背景

| 项 | 内容 |
|---|---|
| Addon 作用 | 把 DeepSeek Harness（DSH）包装成 HA Addon，经 Ingress 提供 Web 设置面板 + 桥接 API |
| 启动方式 | `node --expose-internals $DSH_BIN --profile web --host 127.0.0.1 --port 3081`（run.sh） |
| 代理层 | `proxy.js` 监听 0.0.0.0:3080 → 3081，做五维 loopback 伪装（Host+TCP源+WS+前端 isLoopback+host.describe） |
| 插件市场 | DSH 自带插件安装机制（web 市场 → 内部 `dsh plugin`），addon 不主动支持也不阻碍 |
| dsh-im | `@xmanrui/dsh-im` 社区插件，提供微信/飞书/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp 接入 |
| 安装落点 | `/data/dsh/profiles/web/node_modules/@xmanrui/dsh-im`（容器 `app_0393f39a_deepseek_harness`，DSH_HOME=/data/dsh） |

---

## 3. 排查时间线（排除法）

1. **疑点①：我们改坏了 dsh-im？**
   → 否。dsh-im 是 xmanrui 原装社区插件，addon 只包 DSH，从未修改 dsh-im 源码。

2. **疑点②：loopback 鉴权拒绝（authority: loopback）？**
   → 不成立。读源码确认 dsh-im host 端 RPC 默认 `authority: loopback`，但 addon 的 proxy 已在五维层面伪装成回环（HTTP Host 重生成 127.0.0.1、同容器 TCP 源 127.0.0.1、WS host/origin 改写、前端 isLoopback、host.describe）。**且 404 ≠ 403**：404 是"路由不存在"，不是"拒绝访问"。

3. **疑点③：装完没重启 host 端未加载？**
   → 重启 addon 后仍 404，排除"单纯未加载"。

4. **疑点④：传输层 / 权限 / 安装能力问题？**
   → 经多轮排除，均不成立。dsh-im 已实证成功安装，证明 DSH 在容器内有自己的安装链路。

5. **实锤（外网 SSH）**：
   用 `api.homediy.top`（外网域名，root+密钥）连上容器，核对 DSH 版本与 dsh-im 依赖——**rc.7 缺 `typertGateway` / `webServer` 服务**，cordis 静默跳过 dsh-im host 插件，`/weixin` 未注册，404 坐实。

---

## 4. 根因详解

```
dsh-im 0.11
  └─ host 插件 inject: ['connection','credentials','webServer','typertGateway']
       └─ apply() 无条件 installWeixinRpc() 注册 /weixin/connection.status
            └─ 前置条件：DSH 必须提供 webServer + typertGateway 服务

addon 当前 DSH = latest (rc.7)
  ✗ 缺失 webServer / typertGateway 服务
  → cordis 加载 host 插件时依赖不满足 → 静默跳过（不报错）
  → /weixin RPC 未注册
  → 设置页 GET /weixin/connection.status → HTTP 404

原版 DSH = next (rc.8)
  ✓ 提供 webServer / typertGateway 服务
  → host 插件正常加载 → /weixin 注册 → 正常
```

**关键点**：
- 404 是"路由未注册"，不是"鉴权拒绝"，所以 loopback 伪装方向排查走不通。
- cordis 的"依赖不满足则静默跳过"是 DSH 框架行为，不在 addon 控制范围内。
- 修复点必须在 **DSH 版本层**（addon 层统一升级），不能逐插件改 dsh-im（违反用户架构要求）。

---

## 5. 技术解决方案

### 方案 A（推荐 · 可逆 · 先验证）
在容器内把 DSH 升级到 `next`：
```bash
# 容器内执行（SSH api.homediy.top）
cd /data/dsh
npm install @deepseek-ai/dsh@next --prefix /data/dsh/vendor
# run.sh 已 vendor 优先：DSH_BIN 解析 vendor 优先，否则镜像内置
# 重启 addon 即生效
```
- 优点：不碰镜像、不固化、出问题删 vendor 即回退。
- 风险：vendor 目录持久化，update/重启不会清，验证稳定后再固化。

### 方案 B（固化进镜像）
改 `Dockerfile` 默认安装通道：
```dockerfile
- RUN npm install -g @deepseek-ai/dsh
+ RUN npm install -g @deepseek-ai/dsh@next
```
- 优点：所有用户一次到位。
- 缺点：每次 DSH 发新版需重发 addon，违背"稳定壳 vs 可变层"更新边界原则（见 DESIGN.md §8.0）。

**建议**：先走方案 A 在容器内手动升级 rc.8 验证 dsh-im 404 消失，确认稳定后再决定是否固化进 Dockerfile。

---

## 6. 已改动文件清单（均未提交）

| 文件 | 改动 | 状态 |
|---|---|---|
| `custom_components/deepseek_harness/dsh_client.py` | 修复 `_session` 属性/方法同名遮蔽（P0 阻塞），改名 `_get_session()` | 未提交 |
| `custom_components/deepseek_harness/const.py` | 版本同步 0.2.0 = manifest.json | 未提交 |
| `deepseek_harness/proxy.js` | 从 run.sh heredoc 抽离为独立文件；五维 loopback 伪装；注入失败降级 WARNING | 未提交 |
| `deepseek_harness/run.sh` | DSH_HOME=/data/dsh；vendor 优先；子进程自愈；HA MCP patch 覆盖式写入 | 未提交 |
| `scripts/check-versions.sh` | 四文件全等 → 双轨内部一致校验（addon 轨 / 集成轨） | 未提交 |
| `docs/DESIGN.md` | §2/§2.1/§5.4/§7.2/§10/§11 对齐实现 | 未提交 |
| `README.md` | 双轨版本说明 + 测试与 CI | 未提交 |
| `tests/test_bridge_api.js` + `tests/mock_dsh.js` | 19/19 契约测试 | 未提交 |
| `.github/workflows/ci.yml` | lint/版本/契约/docker 四任务 | 未提交 |

> 注：本轮新增 dsh-im 接入相关的**修复尚未实施**（等待用户批准升级 DSH 版本）。

---

## 7. 风险与后续

- ⚠️ **cordis.patch.yml 覆盖隐患**：run.sh 在 `HA_MCP_ENABLED` 时整体覆盖写 `$DSH_HOME/cordis.patch.yml`（L183 `cat >`）。若未来有插件走"Home 级 patch 注入"方式，会与我们的 HA MCP patch 互相冲掉。dsh-im 走市场注册（profiles）大概率不冲突，但建议后续内网 SSH 实锤其 patch 落点。
- ⚠️ **公网暴露**：此前实测 `api.homediy.top:3080` 曾公网可达（DSH 后门），config.yaml 已删 ports:3080，需确认路由器转发也移除。
- 后续动作（待用户批准）：
  1. 容器内手动升级 DSH 至 rc.8 验证 dsh-im 404 是否消失；
  2. 验证通过后决定是否固化进 Dockerfile；
  3. 全部改动走发布流程（commit/push/tag/Release 需用户明确批准）。

---

## 8. 结论

dsh-im 404 与我们改的插件无关，根因是 **addon 锁定的 DSH 版本（rc.7）缺少 dsh-im 0.11 依赖的 `typertGateway`/`webServer` 服务**，cordis 静默跳过 host 插件导致 `/weixin` 未注册。原版 DSH（rc.8）因版本新而正常。修复方法是把 addon 内 DSH 升级到 `next`（rc.8），优先在容器内 vendor 升级验证，确认稳定后再固化。
