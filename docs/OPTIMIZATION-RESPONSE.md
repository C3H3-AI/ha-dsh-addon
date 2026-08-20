# ha-dsh-addon 优化建议回应

> 日期：2026-08-20
> 对象：针对外部审查者提出的「HA Assist 走 web profile 常驻会话（WS relay）」等优化建议的正式回应。
> 结论先行：**认可"选错 DSH profile"的核心诊断，但 WS relay 的实现成本被低估，且引入与 DSH 高频更新冲突的协议耦合——建议降级为待评估项；先落地低成本高收益的安全/健壮项。**

---

## 一、认可的部分

### ✅ 核心诊断正确：Assist 通道确实"用错了 DSH profile"
- `dsh --profile headless` 是 **one-shot**（"Answer one task, print the final assistant message, and exit"，见 `dsh-headless/lib/startup.js`）。
- web profile（3081）才是常驻进程 + WS 多轮 + 持久会话。
- 桥接层 `api_server.js` 的 `POST /api/chat` 确实每次 `spawn headless`，存在冷启动 + 多轮上下文丢失。
- 这一点与 `api_server.js` 文件头注释预告的升级方向一致（"Multi-turn session relay via the web profile's WebSocket is a later upgrade"）。

### ✅ 合理且低风险的建议（方向对）
- **删 `ports: 3080`**，仅留 ingress——减少暴露面，正确。
- **`/api/chat` 加超时 + 并发锁**——防打爆，正确。
- **健康检查细化**（bridge `/api/status` 探活）——运维体验，正确。
- **README 补「`/data` 随 HA addon 备份」说明**——正确，`$DSH_HOME=/data/dsh` 天然被 HA 备份覆盖。

---

## 二、需要纠正的：WS relay 成本被低估

### ⚠️ "WS relay = 在 bridge 里加一个 WS 客户端" —— 不成立
我去 DSH 源码核实了浏览器 ↔ web profile 的真实传输协议（`dsh-client-connection/lib/client.js`）：

- 下行走两条**专用 WebSocket**：`/api/events.mux` 与 `/api/events.host`，不是标准 JSON-RPC。
- 帧必须通过 `serverRequestSchema` / `muxFrameSchema` / `hostFrameSchema` 校验。
- 模型是 **HTTP 上行（unary/respond 走 fetch）+ 每事件一条 WS 下行** 的双通道。
- 内部经 Cordis RPC 以 `authority: "trusted-host"` 做信任裁决（`dsh-api-gateway/lib/index.js`）。

**含义**：要让 bridge 复用 web 会话，不是在 Node 端"建一个 WebSocket 连接"，而是要在 Node 端**重新实现 DSH 官方的 client-connection 协议栈**（RPC 信封、mux/host 帧、Typert 调用规范）。成本显著高于"中"，且属于 DSH 易变内部。

---

## 三、关键新增论据：DSH 后续更新会放大 WS relay 的耦合成本

> 您的建议着眼当前性能；但本项目的高频痛点恰恰是 **DSH 是 RC 版、频繁升级**。这一点使 WS relay 成为持续维护负债。

- 本项目架构铁律（`dsh_client.py` 头注释）：
  > "The custom_component NEVER talks to DSH's volatile RC internals directly; it only depends on stable contract, so upstream DSH breaking changes only require updating the add-on, never this component."

- 两个通道的属性对比：

| 通道 | 接口 | DSH 升级影响 |
|---|---|---|
| `headless`（CLI） | 稳定契约：argv + stdout | 升级几乎不破坏 |
| `web`（WS relay 需复刻） | 易变私有协议：mux/host 帧 + RPC 信封 | 升级即风险 |

- **冲突放大**：本项目正在设计「Web 一键更新」（网页点一下升到 rc8）。桥上若耦合 web 私有协议，则：
  - 用户点更新 → 前端换新协议 → **bridge 复刻的旧协议直接瘫痪，Assist 通道中断**
  - 必须把 bridge 与 DSH 前端协议**同步锁定 + 一起进 vendor + 一起重启**，复杂度螺旋上升

**结论**：WS relay 的「协议耦合成本 × DSH 高频更新」= 持续负债，而非一次性迁移。这是反对押注 WS relay 的**更充分理由**，同时也是对"考虑后续更新吗"的直接回答——**正因考虑后续更新，才不该做 WS relay**。

---

## 四、落地路径（务实版）

| 优先级 | 项 | 成本 | 状态 |
|---|---|---|---|
| 🔴 现在做 | 删 `ports: 3080`，纯 ingress | 低 | 建议立即 |
| 🔴 现在做 | `/api/chat` 超时(60s) + 并发锁（单飞 + 429） | 低 | 建议立即 |
| 🟡 现在做 | 健康检查增加 bridge `/api/status` 探活 | 低 | 建议立即 |
| 🟢 顺手 | README 补 `/data` 随 HA 备份说明 | 极低 | 建议立即 |
| 🟡 待评估 | Assist 会话复用 | **高** | **降级：先探 DSH CLI 面是否支持会话复用，再决定；不轻易进私有协议层** |

### 若多轮是刚需
优先探索 **DSH 稳定 CLI 面是否支持会话复用/桥接式会话**（headless 会话簿等），而**不**直接复刻 web 私有 WebSocket 协议栈。这样既保留"稳定契约 + 升级无忧"，又能缓解多轮问题。

---

## 五、实测更新（2026-08-20 复验后）

> 双方均亲自复验了 headless 无 `--session` 参数，并进一步下钻到 DSH 会话恢复能力的真实位置。以下是复验后的事实基础与结论修正。

### 5.1 复验确认的事实

| 事实 | 证据 | 确认 |
|------|------|------|
| headless 每次新建随机 session | `dsh-headless/lib/index.js` L71 `sessionId: SessionId(\`session-${randomUUID()}\`)` | ✅ |
| headless CLI 无 session 参数 | `--help` 实测 + `startup.js` 只有 `[task...]`/`-h` | ✅ |
| `dsh-agent.resume()` API 存在 | `dsh-agent/lib/index.js` L556 | ✅ |
| **agent-loop resume 完全实现** | `dsh-agent-loop/lib/index.js` L1256：仅当 `sessionPersistence` 未配置才抛错，配置后即可 `resumeSessionId` 恢复 | ✅ **重要修正** |
| 会话持久化后端已配置 | `run.sh` 已设 `DSH_HOME=/data/dsh`，`sessions` flush 使用它 | ✅ |

### 5.2 关键修正：多轮能力没有被"架构封死"

对方此前用"headless 无会话复用"作为"多轮收益被架构封死→不值得做 WS relay"的依据——**该推理链错误**。

- DSH 的 **会话恢复能力真实存在**（`agent-loop.resume()` + 持久化后端），headless 只是**未通过 CLI 暴露参数**，而非底层不可用。
- 因此"是否做 WS relay"的权衡**结果不变但理由要改**：
  - ❌ 不再是"DSH 做不到多轮"
  - ✅ 而是"多轮的编程入口在 **agent-loop/host 层**（非 CLI），要利用它需在 addon 侧以 **Node 编程方式调用 resume API/**（绕过 headless CLI），或走 web 私有协议"

### 5.3 新的可行路径（此前未考虑）

- **addon 侧 Node 直调 `agent-loop.resume()`**：不 spawn headless CLI，而以 `dsh --profile headless` 之外的**编程入口**加载持久化 session 并续跑 —— 这仍然在 **host 稳定层**，不碰 web 私有帧，但需要确认 DSH 是否暴露了可编程的 host API / service（而非仅 CLI）。
- **keep headless 单轮**（维持现状）：Assist 控制类单轮场景够用。

### 5.4 修正后的最终裁定

| 项 | 裁定 |
|----|------|
| WS relay（复刻 web 私有帧） | ❌ 不做（成本高 + 违反"不碰易变内部"铁律 + 与一键更新冲突） |
| headless 单轮 | ✅ 维持现状 |
| **addon 侧编程调用 `resume()`**（新开口） | 🟡 待评估——需确认 DSH 是否提供 host 层可编程 API；若提供，可成为"多轮 + 稳定层"的折中 |
| 4 个低风险项（删 ports / 超时锁 / 健康 / 备份文档） | ✅ 建议立即落地 |

---

## 六、待答复确认
1. 是否同意最终裁定（WS relay 不做；headless 单轮维持；`resume()` 编程调用作为待评估开口）？
2. 是否先落地 🔴/🟡/🟢 的 4 个低风险项？
3. 是否需进一步验证 **DSH 是否暴露 host 层可编程 API（service 而非 CLI）** 以评估 5.3 路径？

*欢迎对方复核 `dsh-agent-loop/lib/index.js` L1256 `resume()` 实现，以确认「会话恢复能力存在、仅 CLI 未暴露」的判断。*