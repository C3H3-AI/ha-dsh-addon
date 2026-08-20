# ha-dsh-addon 审查意见评价与修改说明

> 日期：2026-08-20
> 对象：针对外部审查者对 ha-dsh-addon（DSH addon）的审查意见，逐条核实后给出评价，并附上已落地的修改清单。
> 结论先行：**审查意见方向正确、质量不错，但存在 2 处基于误读的论断（端口发布、base 镜像切换），1 处被夸大（每次 spawn headless 的影响面）。**

---

## 一、逐条评价

### ✅ 1. "bridge API 无认证" — 成立，已修复

**原文要点**：`/api/chat` 触发带代码执行能力的 DSH，监听 `0.0.0.0:3082` 无 token 校验，是 RCE 入口。

**核实结论**：**成立。** 原始 `api_server.js` 的三个端点（`POST /api/chat`、`GET /api/status`、`POST /api/restart`）确实零鉴权，其中 `/api/chat` 将用户输入直接作为 DSH headless 的对话参数（DSH 具备代码执行/工具调用能力）。虽然 3082 未发布到宿主机端口（见第 3 条），但容器网络内其它 addon/被攻破进程仍可触达，属于真实风险。

**处理**：已加共享密钥鉴权（详见下文「二、修改清单」P0）。

---

### ⚠️ 2. "每次 spawn 一整个 DSH headless 进程" — 事实属实，但影响面被夸大

**原文要点**：`/api/chat` 每次请求 spawn 完整 DSH headless 进程，延迟爆炸、无多轮上下文、并发打爆资源（"chromium 级重 app"）。

**核实结论**：**部分成立。**
- ✅ 属实：`runHeadless()` 确实每次 `spawn('node', [..., '--profile', 'headless', message])`；DSH headless 是 **one-shot**（"Answer one task, print the final assistant message, and exit"），每次冷启动、无会话复用，**多轮上下文确实会丢**。
- ❌ 误读一：**"chromium 级重 app"不成立**。headless 是纯 Node.js/Cordis 进程，不启浏览器渲染，不存在"并发一堆 chromium 内存 OOM"。
- ❌ 误读二：**这不是 DSH 主对话通道**。DSH 主对话走 **3081 端口 WebSocket 常驻进程**（`node --profile web`，多轮、有上下文、有持久会话）。`/api/chat` 只是配套自定义集成（`deepseek_harness`）在 **HA Assist 语音/文本快捷键**场景下的单轮转发，见 `custom_components/deepseek_harness/conversation.py` 与 `dsh_client.py`。因此它拖垮不了主 UI，也并非每次用户对话都冷启动。

**评价**：把"每次 spawn 冷启动 + 丢上下文"指出来是对的，但定性为"架构级硬伤、拖垮主对话"是误读。Assist 通道的常驻化是合理的后续优化（P1），非 P0 阻塞项。

---

### ❌ 3. "ports: 3080 + ingress 同时开 = 把执行入口 publish 到 LAN" — 误读

**原文要点**：`ports: 3080/tcp` 与 `ingress: true` 同时开启，等于把执行入口发布到局域网，绕过 Ingress 鉴权。

**核实结论**：**不成立。**
- `config.yaml` 的 `ports` **只有 `3080/tcp: 3080`，从未发布 3082**。bridge API 的 `0.0.0.0:3082` 仅在容器内部网络可达，**未映射到宿主机/局域网端口**。
- 发布到 LAN 的 3080 是**纯 HTTP 代理**（`run.sh` 中的 `/tmp/proxy.js`，转发到 127.0.0.1:3081 的 DSH Web UI），**不含任何执行入口**。
- 真正该担心的是"容器网络内其它 addon 能否访问 3082"——这是加 token 的动机，而非"publish 到 LAN"。

**评价**：安全敏感度是对的（结论方向正确），但论据（端口发布）是误读。已按正确论据修复（加鉴权）。

---

### ❌ 4. "§9 把 base 从 alpine 切到 bookworm" + "bookworm 依赖未验证" — 不实

**原文要点**：审查认为 §9 将基础镜像从 alpine 切换到 bookworm-slim，且新镜像依赖未验证，有构建风险。

**核实结论**：**不成立。**
- 历史事实：`Dockerfile` **一直是 `FROM node:22-bookworm-slim`**（注释明确：node-pty 等原生模块需要 glibc，不用 Alpine）。不一致的只是 `build.yaml` 的 `build_from` 写成 alpine，§9 修改是**把 build.yaml 对齐回 Dockerfile 实际使用的 bookworm**，不是"切换基础镜像"。
- 该 addon 已在 **aarch64 生产环境以 bookworm 运行**，`settings.yaml` 正常、DSH 可启动并编译原生模块（node-pty）——**bookworm 依赖已过生产验证**。

**评价**：误读。§9 是"配置对齐"，不是"镜像切换"；"未验证"不成立。

---

### 🟡 5. 其余优化建议（loopback 伪装、健康检查/自愈）— 合理，属增强项

- **反代替 patch（Caddy/nginx Host 重写）**：方向正确，比运行时 monkey-patch 更稳；但现有双层方案（前端 `Location.prototype.hostname` + 后端 `/api/host.describe` 递归改写）**已验证可用、零新增依赖**，属锦上添花，优先级低于安全修复。
- **健康检查/自愈**：当前 `run.sh` 用 `wait DSH_PID`，DSH 崩溃后靠 Supervisor watchdog 拉起，无进程内 respawn。可增强，非 P0。

---

## 二、修改清单（已落地，未提交）

> 状态：全部改动在工作区，**未 commit / push / tag**（按项目发布铁律，待批准后提交）。

### P0 — Bridge API 共享密钥鉴权（addon 0.2.13 → 0.2.14）

**addon 侧 `ha-dsh-addon/deepseek_harness/`**

| 文件 | 修改 |
|---|---|
| `api_server.js` | 新增 `API_TOKEN`（读 `DSH_API_TOKEN` 环境变量）；`tokenMatches()` 常量时间比较防时序侧信道；路由层校验 `Authorization: Bearer <token>`；**fail-closed**：未配 token 或 token 错误时写操作返回 401（含中文提示），只读 `GET /api/status` 放行以便排查 |
| `config.yaml` | `options`/`schema` 新增 `api_token`（`password` 类型，UI 不明文显示） |
| `run.sh` | 三路配置源（`/data/options.json` / `HASSIO_OPTIONS` / 默认值）均读取 `api_token`，导出 `DSH_API_TOKEN`；启动日志提示鉴权启用状态 |
| `Dockerfile` | `BUILD_VERSION` 0.2.13 → 0.2.14 |

**集成侧 `deepseek_harness/`（custom_component，0.1.0 → 0.2.0）**

| 文件 | 修改 |
|---|---|
| `const.py` | 新增 `CONF_API_TOKEN = "api_token"` |
| `config_flow.py` | 配置向导新增可选 `api_token` 字段 |
| `dsh_client.py` | `DSHClient.__init__` 新增 `api_token` 参数；`_headers()` 对三个端点统一携带 `Authorization: Bearer`；401 时返回明确中文错误（"addon 与集成需填相同 api_token"） |
| `__init__.py` | 从 config entry 读取 `api_token` 并透传给 `DSHClient` |
| `manifest.json` | version 0.1.0 → 0.2.0 |

**行为验证（实际启动 api_server + curl，5/5 通过）**

| 用例 | 期望 | 实际 |
|---|---|---|
| `GET /api/status` 无 token（只读） | 200 | ✅ 200 |
| `POST /api/chat` 无 token | 401 | ✅ 401 |
| `POST /api/chat` 错误 token | 401 | ✅ 401 |
| `POST /api/chat` 正确 token | 穿透鉴权进入 handler | ✅（测试机无 DSH，返回 502 属预期） |
| `POST /api/restart` 正确 token | 穿透鉴权进入 handler | ✅（无 SUPERVISOR_TOKEN，返回 500 属预期） |

### P2 — 仓库清洁与行尾规范

| 项 | 内容 |
|---|---|
| `.gitattributes` | 强制容器关键文件 `eol=lf`（Dockerfile / `*.sh` / `*.yaml` / `*.js` / `*.py` / `*.json` / `*.md`），防 CRLF 破坏 Dockerfile 续行与 shell 脚本 |
| `.gitignore` | 忽略 `.scratch/`、`debug/`、`commit_msg*.txt`、`test_*.js` 等调试产物 |
| `.scratch/` | 仓库根目录 13 个调试文件（`commit_msg*.txt`×7、`debug_proxy*.js`×2、`test_api*.js`×3、`test_dsh_proxy.js`、`debug/`）统一归置，git 状态已干净 |

---

## 三、开放项（未做，待决策）

1. **commit / tag / push**：待项目负责人批准（发布铁律）。
2. **`docs/DESIGN.md` 纳入版本库**：当前为 untracked，建议随下次提交一并入库。
3. **Assist 通道常驻化（P1）**：让 `/api/chat` 复用 3081 WebSocket 会话，解决单轮转发冷启动与上下文丢失——需评估 DSH 会话协议，非阻塞。
4. **反代替 patch / 健康自愈（P1）**：可选增强，现有方案已验证可用。

---

*本文件基于对 addon 与集成源码、DSH 上游 headless/web 协议、以及实际运行环境的核实编写，欢迎对方逐条复核。*
