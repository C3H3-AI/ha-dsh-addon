# Addon 开发调试经验（实战沉淀）

> 本文记录 `ha-dsh-addon` 开发/排障中**真实踩过的坑**与**可复用的排查方法**。
> 与 `DESIGN.md`（设计方案）互补：那边讲"为什么这么设计"，这边讲"坏了怎么查、怎么验证"。

---

## 0. 环境速查

| 项 | 值 |
|----|-----|
| SSH | `ssh -i D:/ai-hub/_ha_key2.pem -p 22222 root@api.homediy.top` |
| addon 容器 | `app_301cfdf7_deepseek_harness` |
| HA 容器 | `homeassistant` |
| DSH web | `127.0.0.1:3081`（容器内） |
| bridge API | `0.0.0.0:3082`（容器内） |
| Ingress 代理 | `3080` |
| 架构 | `aarch64` |

**取 Supervisor token**（很多 API 调用都要它）：
```bash
docker exec homeassistant sh -c "env | grep SUPERVISOR_TOKEN"
```

---

## 1. 最大的坑：热部署 ≠ 持久化

### 现象
改完 `api_server.js` / `custom_components/*.py` 并 `docker cp` 进容器，功能正常。
但**容器一重启，改动全丢**，回到镜像内置旧版。

### 根因
`run.sh` 每次启动都会执行：
```bash
rm -rf /config/custom_components/deepseek_harness   # 先清空
cp -a /custom_components/deepseek_harness ...        # 再从镜像内置目录拷
```
所以**镜像内才是权威**，热部署只是临时覆盖。

### 正确做法
1. 改代码 → 提交推送到 GitHub
2. **重建/更新镜像**（关键步骤，别跳过）
3. 验证镜像内已含修复：
```bash
docker run --rm <image> sh -c "grep -c chat_session /custom_components/deepseek_harness/dsh_client.py"
```

### 持久化验证清单
```bash
# 1) 镜像里有没有
docker run --rm <image> sh -c "grep -c ConversationResult /custom_components/deepseek_harness/conversation.py"
# 2) 运行容器和仓库是否逐字节一致
docker exec <container> md5sum /config/custom_components/deepseek_harness/*.py
md5sum custom_components/deepseek_harness/*.py   # 本地仓库
```

---

## 2. 这台机器 GitHub / 外网不通（反复踩）

### 表现
- Supervisor `rebuild`/`update` 失败：`Failed to connect to github.com port 443 after 130189 ms`
- `git push` 偶发 `TLS connect error` / `Recv failure`（重试通常能过）
- HACS 更新超时：`Timeout ... api.github.com`
- Docker build `--pull` 失败：`TLS handshake timeout` 拉 `docker.io/library/node`

### 应对
| 场景 | 解法 |
|------|------|
| git push 失败 | **重试 2~3 次**通常成功；代理 `http://127.0.0.1:7890` |
| 镜像构建拉不到基础镜像 | 用**本地缓存**的基础镜像：`docker images` 里通常已有 `node:22-bookworm-slim`，build 时指定 `--build-arg BUILD_FROM=node:22-bookworm-slim` 且**不加 `--pull`** |
| Supervisor 想 clone 源码重建 | **放弃联网路径**，改本地手工 build 后打 tag |

### 手工构建模板（离线、用缓存）
```bash
docker build . \
  --tag 301cfdf7/aarch64-addon-deepseek_harness:<VER> \
  --platform linux/arm64 \
  --label io.hass.version=<VER> --label io.hass.arch=aarch64 \
  --build-arg BUILD_VERSION=<VER> --build-arg BUILD_ARCH=aarch64 \
  --build-arg BUILD_FROM=node:22-bookworm-slim
```
> 构建约 20~40 分钟（要 apt + npm install）。**超过工具 10 分钟上限，务必用 `nohup ... &` 放后台**，别在前台干等。

### 让 Supervisor 用本地镜像（不再联网）
把构建好的镜像同时打上 Supervisor 期望的 tag：
```bash
docker tag <image>:0.2.32 <image>:0.2.31   # 两个 tag 指向同一镜像
```
这样无论它认哪个版本，本地都有，不会触发联网构建。

---

## 3. addon 是从源码构建的（不是预拉镜像）

`config.yaml` **没有 `image:` 键** → Supervisor 从 GitHub 仓库 + `build.yaml` 构建。
因此：
- 每次 "rebuild" 都会尝试联网（而这台机器不通）
- 版本不一致时 Supervisor 会拒绝 rebuild：
  `Local and store versions differ, use Update instead of Rebuild`

**build.yaml 已废弃警告**：`App uses build.yaml which is deprecated. Move build parameters into the Dockerfile directly.`
（功能仍可用，但后续可考虑迁到 Dockerfile）

---

## 4. 双轨版本号 + 两份 custom_components（易错）

### 双轨版本（CI 强校验）
| 轨 | 文件 | 必须相等 |
|----|------|---------|
| addon | `config.yaml` == `Dockerfile`(ARG BUILD_VERSION) | ✅ |
| 集成 | `const.py`(VERSION) == `manifest.json`(version) | ✅ |

改版本后必跑：`bash scripts/check-versions.sh`
> 曾踩坑：只改了 `config.yaml` 忘了 `Dockerfile` → CI 直接红。

### 两份 custom_components（重要）
```
custom_components/                    # 仓库根：HACS 分发 + scripts/check-versions.sh 读取
deepseek_harness/custom_components/   # Docker 构建源（CI context 是 deepseek_harness）
```
**两份必须保持一致**，否则：
- HACS 用户拿到旧/坏代码
- 版本检查读到旧值

改完记得同步（用 md5 逐个核对最稳）。

---

## 5. DSH 会话协议调试（path A 核心）

### 端点与包络
DSH web profile 在 `127.0.0.1:3081` 提供 Typert Remote RPC，**走普通 HTTP POST，无需 cookie 鉴权**（loopback 通过 Host/Origin 围栏）：
```jsonc
// 请求
POST /api/<endpoint>
{"type":"client-request","rpcId":"<id>","method":"session.prompt","payload":{...}}
// 响应
{"type":"server-response","rpcId":"<id>","result":{"ok":true,"value":{...}}}
```

### 关键 RPC
| RPC | 用途 |
|-----|------|
| `workspace.list` | 取 workspaceId（**会话要挂到 workspace 才会显示在 UI**） |
| `session.create` | 建会话；传 `{workspaceId}` 注册；传 `{workspaceId, sessionId}` 可**认领**已有会话 |
| `session.list` / `session.history` | 列表 / 历史事件 |
| `session.prompt` | 发消息，**立即返回 `{accepted:true}`**（异步！） |

### 取回复：发完要轮询（最容易误解的点）
`session.prompt` **不等回复**。流程：
1. `session.history` 取基线 `seq`
2. `session.prompt`（记下 envelope 的 `rpcId`）
3. **轮询 `session.history`**，找 `user/message` 且 `data.source.rpcId == 你的 rpcId` → 确定 `targetTurn`
4. 收集 `assistant/chunk`(text-delta) 与 `assistant/message`，且 `data.turn == targetTurn`
5. 遇 `turn/end`（turn 匹配）结束

> ⚠️ 关联键是 **envelope 的 `rpcId`**，不是 payload 里的 `requestId`。
> 曾在这里卡住：把 requestId 放 payload，导致永远匹配不到 user/message，拿到空回复。

### 会话必须注册到 workspace 才显示在 UI
DSH 的会话树**按 workspace 分组渲染**。用 `session.create({})`（空参数）建的会话是**游离的**，UI 不显示。
修复（沿用 dsh-im 的 `adoptRegisteredWorkspaceSession` 思路）：
- 新建时带 `workspaceId`
- 对已存在但游离的会话，用 `session.create({workspaceId, sessionId})` 补认领（幂等）

验证游离会话：
```js
const wl = await rpc("workspace.list",{});
const reg = new Set(wl.items.flatMap(w=>w.sessionIds));
const orphans = (await rpc("session.list",{})).items.map(s=>s.sessionId).filter(id=>!reg.has(id));
```

---

## 6. 直接用 RPC 做冒烟测试（比走 HA 快得多）

在 addon 容器内跑 node 脚本，绕过 HA 直接验链路：
```js
const BASE="http://127.0.0.1:3081";
async function rpc(method,payload,rpcId){ /* POST /api/<method> */ }
// 建会话 → prompt → 轮询 history → 拿 text
```
**用途**：区分"DSH 的问题"还是"HA 集成的问题"。
先直连 RPC 验通，再走 HA；直连不通就别怀疑 HA。

### curl 快速冒烟（bridge 层）
```bash
curl -s -X POST http://127.0.0.1:3082/api/session \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api_token>" \
  -d '{"message":"只回复两个字：确认","session":null}'
```

---

## 7. HA 集成侧的坑

### 7.1 HA 2026.8 移除了 `conversation.result()`
必须返回 dataclass：
```python
return conversation.ConversationResult(response=response, conversation_id=cid)
```
否则调用返回 **500**（日志：`AttributeError: module has no attribute 'result'`）。
> 这是"只看代码不实测"最容易漏的兼容性问题。

### 7.2 集成改了要 reload 才生效
改 `custom_components/` 后 HA **不会热加载**，需重启 HA 或重载 config entry。
注意：重启 HA 会触发 addon 的 `run.sh` 重新部署（见 §1）。

### 7.3 用 websocket 创建长期令牌
注意字段名是 **`lifespan`**（天），不是 lifetime，且必须带 `id`：
```json
{"id":11,"type":"auth/long_lived_access_token","client_name":"x","lifespan":3650}
```

### 7.4 实体命名
中文实体名会生成拼音 entity_id（如 `button.deepseek_harness_geng_xin_dsh`），属正常。

---

## 8. MCP 排障（本次最大的一次误判）

### 教训：先确认"端点是否真的通"，别急着改配置
我一开始看到 DSH 报 `Streamable HTTP error: Unexpected content type: null`，
判断为"缺 token"，于是创建 LLAT、加 Authorization 头……**全是无用功**。

**正确排查顺序**：
1. `curl -D -` 看**完整响应头**（别只看 HTTP 码）
   → 发现：`server: nginx`、`content-length: 0`、**无 content-type**
2. 结论：请求被 nginx 吞了，**压根没到 HA**，加什么 token 都没用
3. 再查 HA 侧：发现装的是 `ha_mcp_tools`（不是官方 MCP Server），
   且其**内嵌 server 起不来**：
   `HA-MCP in-process server did not become reachable on port 9583`

### 排查命令
```bash
# 看完整响应头（关键！）
curl -s -D - -o /tmp/b.txt -X POST -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "<mcp body>" "<url>"
# 查 HA 装了哪些 MCP 相关集成
docker exec homeassistant sh -c "ls /config/.storage | grep -i mcp"
# 看 HA 日志里 MCP 的状态
docker logs homeassistant 2>&1 | grep -iE "ha_mcp|mcp" | tail -20
```

### 结论
- **token 不是问题**（带不带 token 都是空 200）
- 根因在 HA 侧 `ha_mcp_tools` 内嵌 server，与 addon/DSH 配置无关
- 已把误加的配置全部回退，保持环境干净

---

## 9. 通用排障心法（本次反复验证有效）

1. **先分层，再动手**——明确问题在 HA / bridge / DSH / LLM 哪一层，
   用最小命令逐层验证（直连 RPC 是最快的一层）
2. **别只看 HTTP 状态码**——`200` 可能是 nginx 的空响应；
   必须 `curl -D -` 看响应头 + body
3. **别凭印象下结论**——我说"MCP 缺 token"就是凭印象，实测才发现全错
4. **改前先备份**——改配置文件前一律 `cp` 一份（`.bak`），方便回退
5. **验证要看到真实数据**——"返回 200"不等于"功能正常"，要有真实响应内容
6. **长任务放后台**——构建/重启超过几分钟的，用 `nohup ... &`，别前台死等（会超时）
7. **改了要验证持久化**——热部署有效 ≠ 重启后还有效（§1）
8. **回退要彻底**——检查所有改动点（文件、Supervisor options、tag），别只回退一处

---

## 10. 常用命令速查

```bash
# 服务状态
docker ps --format "{{.Names}} | {{.Status}}" | grep -E "deepseek|homeassistant"
# bridge 健康
docker exec app_301cfdf7_deepseek_harness curl -s http://127.0.0.1:3082/api/status
# DSH web 是否在跑
docker exec app_301cfdf7_deepseek_harness curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3081/
# 重启 bridge（run.sh 会 respawn）
docker exec app_301cfdf7_deepseek_harness sh -c "kill $(pgrep -f api_server.js)"
# Supervisor API
curl -s -X POST -H "Authorization: Bearer <SUPERVISOR_TOKEN>" \
  http://supervisor/addons/301cfdf7_deepseek_harness/restart
# 改 addon options（必须提交完整 options，缺字段会报 invalid）
curl -s -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"options":{...全部字段...}}' \
  http://supervisor/addons/301cfdf7_deepseek_harness/options
```
