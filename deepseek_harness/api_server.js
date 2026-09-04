'use strict';

/**
 * DeepSeek Harness add-on - stable bridge API.
 *
 * Exposes a small, version-stable HTTP API that the `deepseek_harness` HA
 * custom_component depends on. The custom_component NEVER talks to DSH's
 * volatile RC internals directly; it only calls this contract:
 *
 *   POST /api/session { message, session? }  -> { text, sessionId }
 *   GET  /api/status                          -> { online, ... }
 *   POST /api/restart                         -> { ok }
 *   GET  /api/update/status                   -> { current, latest, next, ... }
 *   POST /api/update  { channel }             -> { ok, version }
 *
 * The conversation path is the multi-turn session relay (path A): it talks to
 * the running web profile's Typert Remote RPC surface at 127.0.0.1:3081 over
 * plain HTTP POST /api/<endpoint> (workspace.list, session.create,
 * session.list, session.history, session.prompt), so the HA conversation keeps
 * real memory across turns. The returned `sessionId` is used as the HA
 * conversation_id.
 *
 * Sessions are created with (or adopted into) a workspace, because DSH renders
 * its session tree grouped by workspace: an unregistered session never shows in
 * the DSH UI.
 */

const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DSH_API_PORT || '3082', 10);
const DSH_BIN =
  process.env.DSH_BIN ||
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
// DSH web profile port. Env-overridable so the contract tests can point the
// bridge at a mock DSH RPC server (see tests/mock_dsh_web.js).
const DSH_WEB_PORT = parseInt(process.env.DSH_WEB_PORT || '3081', 10);
// 共享密钥鉴权：由 run.sh 从 addon 配置 (api_token) 注入。
// 未配置时对写操作 fail-closed（401），防止容器网络内未授权调用触发 DSH 代码执行。
const API_TOKEN = process.env.DSH_API_TOKEN || '';
// 一键更新相关
const VENDOR_DIR = '/data/dsh/vendor';
const VENDOR_TMP = '/data/dsh/vendor.tmp';
const VENDOR_DSH_BIN = path.join(VENDOR_DIR, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';

// 常量时间比较，避免时序侧信道
function tokenMatches(header) {
  if (!API_TOKEN) return false;
  const expected = `Bearer ${API_TOKEN}`;
  if (typeof header !== 'string' || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// 幂等发送：同一响应只能写出一次。
// 避免 handleStatus/handleRestart 中多个回调（timeout+error / response+error）
// 竞态触发二次 writeHead 导致 ERR_HTTP_HEADERS_SENT 崩溃。
function sendJson(res, code, obj) {
  if (res.writableEnded) return; // 已发送过，忽略后续（先到先得）
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}


// ---- 多轮会话中继（path A：DSH web 的 Typert Remote RPC）----
// 直接向运行中的 web profile（127.0.0.1:3081）发起 session 类 RPC。
// 请求/响应包络与 DSH 浏览器客户端一致：
//   请求 {type:'client-request', rpcId, method, payload:{args:{request}}}
//   响应 {type:'server-response', rpcId, result:{ok, value|error}}
// 说明：走 loopback（127.0.0.1）通过 DSH 的 Host/Origin 围栏；DSH 0.1.2-rc+ 对
// 全部 API 强制 browser-session 认证（无 Cookie 返回 401）。Cookie 是 HMAC-SHA256
// 签名的 authority 绑定凭证，签名 secret 持久化在 $DSH_HOME/.credentials.yaml 的
// client-connection/browser-session 记录里。launch token 每次进程变化且 dsh-web-app
// 在 profile 加载慢/无头时可能不打印，因此这里直接读取持久化 secret 自行构造等价
// Cookie（权威性等同 token 交换产物，且跨进程重启有效）。
const DSH_WEB_ORIGIN = 'http://127.0.0.1:' + DSH_WEB_PORT;

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

// 读取 DSH 持久化凭据中的 browser-session 签名 secret（base64url 32 字节）。
function readBrowserSessionSecret() {
  const credPath = process.env.DSH_CREDENTIALS_PATH || path.join(process.env.DSH_HOME || '/data/dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(credPath, 'utf8');
    const m = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const secret = Buffer.from(m[1], 'base64url');
    if (secret.byteLength !== 32) return null;
    return secret;
  } catch {
    return null;
  }
}

// 用 secret 生成与 DSH browser-auth 完全一致的签名 Cookie（name 与 payload 均绑定 authority）。
function makeDshCookie(secret) {
  const authority = '127.0.0.1:' + DSH_WEB_PORT;
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const body = b64u(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  }), 'utf8'));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return name + '=' + 'v1.' + body + '.' + sig;
}

// DSH browser-session cookie。优先取 run.sh 换取的（兼容旧流程），否则自生成。
const DSH_BRIDGE_COOKIE = process.env.DSH_BRIDGE_COOKIE || (() => {
  const secret = readBrowserSessionSecret();
  if (secret) {
    const cookie = makeDshCookie(secret);
    console.log('[DSH Addon] browser-session cookie generated from persisted secret');
    return cookie;
  }
  console.warn('[DSH Addon] WARNING: no browser-session cookie available (bridge RPC will 401)');
  return '';
})();

// 单次 DSH web RPC 调用。rpcId 可选，供 session.prompt 用作文本流关联键。
// DSH 0.1.2-rc+: endpoint 改为 <ns>/<method>（点转斜杠），payload 包装为
// { args: { request: <原参数> } }（list 等个别方法参数名不同，见具体调用处）。
async function dshRpc(method, payload, rpcId) {
  const wireMethod = method.replace(/\./g, '/');
  const headers = { 'content-type': 'application/json' };
  if (DSH_BRIDGE_COOKIE) headers['cookie'] = DSH_BRIDGE_COOKIE;
  const res = await fetch(DSH_WEB_ORIGIN + '/api/' + wireMethod, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: rpcId || 'dsh-bridge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method: wireMethod,
      payload: { args: { request: payload } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error('DSH web ' + wireMethod + ' 返回 HTTP ' + res.status);
  }
  const body = await res.json();
  if (body?.result?.ok !== true) {
    const err = body?.result?.error ?? {};
    const e = new Error((err.message || '未知错误'));
    e.code = err.code || 'rpc-failed';
    e.details = err.details || {};
    throw e;
  }
  return body.result.value;
}

// 取一个会话的历史事件基线 seq（避免把历史助手消息误当本次回复）
// DSH 0.1.2-rc+: session.history 更名为 session/page（backwards page，records 是事件数组）。
async function sessionBaselineSeq(sessionId) {
  const page = await dshRpc('session.page', {
    address: { kind: 'session', sessionId },
    throughSeq: -1,
    maxMessages: 1,
  });
  const records = page?.records ?? [];
  return Math.max(-1, ...records.map((r) => r.event?.seq ?? -1));
}

// 挑选或创建会话：
// - 给了 sessionId 且仍存在 -> 沿用（同一 HA 对话的多轮）。
// - 否则（新对话 / 旧 id 已失效）-> 新建会话。
// 注意：不再复用"最近活跃的其它会话"。此前复用会把新的 HA 对话追加到
// 一个已经很长的历史会话里（累计上万事件 / 十万级 token），导致每次
// 请求都重放巨大上下文，触发 LLM provider 限流（"请求太频繁，AI 服务限流中"）。
// DSH 0.1.2-rc+: workspace 不再暴露 list RPC（改为 follow stream），无法在创建
// 前枚举工作区，直接无参创建（会话功能不受影响，仅不预挂到 workspace 树）。
async function resolveSession(sessionId) {
  if (typeof sessionId === 'string' && sessionId) {
    try {
      await sessionBaselineSeq(sessionId);
      return sessionId; // 存在则沿用
    } catch {
      // session-not-found 或已失效 -> 落到新建
    }
  }
  const created = await dshRpc('session.create', {});
  return created.sessionId;
}

// DSH 0.1.2-rc+ 移除了 workspace.list RPC（改为 follow stream），旧版
// ensureWorkspaceRegistered / sessionCreatePayload（依赖 workspace.list 枚举工作区
// 并把会话预挂到 workspace 树）已不可用。会话改由 session.create 无参创建，
// 功能不受影响，仅不预挂 workspace 树（DSH UI 按工作区分组展示时可能不显示）。

// 从一条会话事件里抽取助手文本（assistant/message 的 content 中的 text 段）
function assistantText(ev) {
  return (ev?.data?.message?.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// 多轮中继：prompt 后轮询 session.page，按 promptRpcId 关联并累计助手文本，
// 到 turn/end 结束。超时抛错。
async function relaySession(message, sessionId, timeoutMs = 120_000) {
  const baselineSeq = await sessionBaselineSeq(sessionId);
  const promptRpcId = 'dsh-bridge-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  await dshRpc('session.prompt', {
    requestId: promptRpcId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: message }],
    clientTimeZone: 'Asia/Shanghai',
  }, promptRpcId);

  const tracker = {
    promptRpcId,
    lastSeq: baselineSeq,
    openTurn: null,
    targetTurn: null,
    stepText: new Map(),
    finished: false,
    text: '',
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !tracker.finished) {
    await sleep(400);
    let hist;
    try {
      hist = await dshRpc('session.page', {
        address: { kind: 'session', sessionId },
        throughSeq: -1,
        maxMessages: 100,
      });
    } catch (e) {
      // 轮询瞬时失败则继续，直到超时
      continue;
    }
    const events = (hist.records ?? [])
      .map((r) => r.event)
      .filter(Boolean)
      .sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
    for (const ev of events) {
      const seq = ev.seq ?? -1;
      if (seq <= tracker.lastSeq) continue;
      tracker.lastSeq = seq;
      if (ev.type === 'turn/start') { tracker.openTurn = ev.data?.turn ?? null; continue; }
      if (ev.type === 'user/message' && ev.data?.source?.rpcId === tracker.promptRpcId) {
        tracker.targetTurn = tracker.openTurn;
        continue;
      }
      if (tracker.targetTurn === null) continue;
      if (ev.type === 'turn/end' && ev.data?.turn === tracker.targetTurn) {
        tracker.finished = true;
        break;
      }
      if (ev.data?.turn !== tracker.targetTurn) continue;
      if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'text-delta') {
        const step = ev.data?.step ?? 0;
        const idx = ev.data.chunk.index ?? 0;
        const key = step + ':' + idx;
        tracker.stepText.set(key, (tracker.stepText.get(key) ?? '') + ev.data.chunk.text);
        const text = [...tracker.stepText.entries()]
          .filter(([k]) => k.startsWith(step + ':'))
          .sort(([a], [b]) => Number(a.split(':')[1]) - Number(b.split(':')[1]))
          .map(([, v]) => v)
          .join('\n')
          .trim();
        if (text && text !== tracker.text) tracker.text = text;
      } else if (ev.type === 'assistant/message') {
        const t = assistantText(ev);
        if (t && t !== tracker.text) tracker.text = t;
      }
    }
  }
  if (!tracker.finished) {
    throw new Error('DSH 会话回复超时（' + Math.round(timeoutMs / 1000) + 's）');
  }
  return tracker.text;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let sessionRelayInFlight = false;

async function handleSession(req, res) {
  // 单飞锁：同一时间只允许 1 个会话中继
  if (sessionRelayInFlight) {
    sendJson(res, 429, { text: 'DSH 正在处理上一条会话请求，请稍后再试', sessionId: null });
    return;
  }
  sessionRelayInFlight = true;
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const message = (body.message || '').toString();
    if (!message) {
      sendJson(res, 400, { text: '缺少 message 字段', sessionId: null });
      return;
    }
    const sessionId = await resolveSession(body.session);
    const text = await relaySession(message, sessionId);
    sendJson(res, 200, { text, sessionId });
  } catch (e) {
    sendJson(res, 502, { text: 'DSH 会话调用失败: ' + e.message, sessionId: null });
  } finally {
    sessionRelayInFlight = false;
  }
}


function handleStatus(req, res) {
  const probe = http.request(
    {
      hostname: '127.0.0.1',
      port: DSH_WEB_PORT,
      path: '/',
      method: 'GET',
      timeout: 2000,
    },
    (p) => {
      p.resume();
      sendJson(res, 200, {
        online: true,
        dsh: 'web reachable',
        bridge: 'ok',
        note: 'headless available',
      });
    }
  );
  probe.on('error', () =>
    sendJson(res, 200, { online: false, dsh: 'web unreachable' })
  );
  probe.on('timeout', () => {
    probe.destroy();
    sendJson(res, 200, { online: false, dsh: 'web timeout' });
  });
  probe.end();
}

// 触发 Supervisor 重启 addon（fire-and-forget，不需要响应对象）
function triggerRestart() {
  const token = process.env.SUPERVISOR_TOKEN;
  const slug = process.env.SUPERVISOR_ADDON_SLUG || 'deepseek_harness';
  if (!token) {
    console.error('[DSH Addon] restart skipped: no SUPERVISOR_TOKEN');
    return;
  }
  const r = http.request(
    {
      hostname: 'supervisor',
      port: 80,
      path: `/addons/${slug}/restart`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    },
    (p) => {
      p.resume();
      console.log('[DSH Addon] restart triggered');
    }
  );
  r.on('error', (e) => console.error('[DSH Addon] restart error:', e.message));
  r.end();
}

function handleRestart(req, res) {
  const token = process.env.SUPERVISOR_TOKEN;
  const slug = process.env.SUPERVISOR_ADDON_SLUG || 'deepseek_harness';
  if (!token) {
    sendJson(res, 500, { ok: false, error: '缺少 SUPERVISOR_TOKEN' });
    return;
  }
  const r = http.request(
    {
      hostname: 'supervisor',
      port: 80,
      path: `/addons/${slug}/restart`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    },
    (p) => {
      p.resume();
      sendJson(res, 200, { ok: true });
    }
  );
  r.on('error', (e) => sendJson(res, 502, { ok: false, error: e.message }));
  r.end();
}

// ---- 一键更新（DESIGN.md §8）----
// 读取当前 DSH 版本（vendor 优先，否则镜像内置）
function currentDshVersion() {
  const pkgJson = path.join(path.dirname(DSH_BIN), '..', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgJson, 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// npm view dist-tags（latest / next），带超时
function npmDistTags() {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['view', '@deepseek-ai/dsh', 'dist-tags', '--json', '--registry', NPM_REGISTRY],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function handleUpdateStatus(req, res) {
  const [tags, vendorExists] = await Promise.all([
    npmDistTags(),
    fs.existsSync(VENDOR_DSH_BIN),
  ]);
  sendJson(res, 200, {
    ok: true,
    current: currentDshVersion(),
    usingVendor: vendorExists,
    latest: tags?.latest ?? null,
    next: tags?.next ?? null,
    registry: NPM_REGISTRY,
    registryReachable: tags !== null,
  });
}

// POST /api/update { channel: "latest"|"next" }
async function handleUpdate(req, res) {
  let channel = 'next';
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    if (body.channel === 'latest' || body.channel === 'next') channel = body.channel;
  } catch {
    // 默认 next
  }

  // 避免并发更新
  if (updateInFlight) {
    sendJson(res, 429, { ok: false, error: '更新已在进行中' });
    return;
  }
  updateInFlight = true;

  // 后台执行，先回 202 让前端轮询 status
  sendJson(res, 202, { ok: true, message: `开始更新到 ${channel}，完成后容器将重启` });
  runUpdate(channel).catch((e) => console.error('[DSH Addon] update failed:', e.message));
}

let updateInFlight = false;
let updateResult = null;

// 后台更新：npm install 到 vendor.tmp → 原子改名 → 重启容器
async function runUpdate(channel) {
  const marker = path.join(VENDOR_DIR, '.updated');
  updateResult = { status: 'installing', channel, at: new Date().toISOString() };
  try {
    // 1. 清理残留 tmp
    fs.rmSync(VENDOR_TMP, { recursive: true, force: true });
    fs.mkdirSync(VENDOR_TMP, { recursive: true });

    // 2. npm install 到 vendor.tmp（npmmirror 国内源）
    await new Promise((resolve, reject) => {
      execFile(
        'npm',
        [
          'install', `@deepseek-ai/dsh@${channel}`,
          '--prefix', VENDOR_TMP,
          '--registry', NPM_REGISTRY,
          '--no-audit', '--no-fund',
        ],
        { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[DSH Addon] npm install failed:', stderr.slice(0, 1000));
            reject(new Error('npm install 失败: ' + (stderr || err.message).slice(0, 300)));
          } else {
            resolve();
          }
        }
      );
    });

    // 3. 校验 vendor.tmp 里 DSH 存在
    const tmpBin = path.join(VENDOR_TMP, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    if (!fs.existsSync(tmpBin)) throw new Error('安装成功但未找到 DSH bin');

    // 4. 原子切换：旧 vendor 备份为 vendor.old，tmp 改名为 vendor
    fs.rmSync(VENDOR_DIR + '.old', { recursive: true, force: true });
    if (fs.existsSync(VENDOR_DIR)) fs.renameSync(VENDOR_DIR, VENDOR_DIR + '.old');
    fs.renameSync(VENDOR_TMP, VENDOR_DIR);

    // 5. 写更新标记（run.sh 据此提示"已由一键更新安装"）
    fs.writeFileSync(marker, JSON.stringify({
      channel, at: new Date().toISOString(),
      version: JSON.parse(fs.readFileSync(path.join(path.dirname(VENDOR_DSH_BIN), '..', 'package.json'), 'utf-8')).version,
    }, null, 2));

    updateResult = { status: 'done', channel, at: new Date().toISOString() };

    // 6. 重启 addon（异步，稍等让 202 响应先发出）
    setTimeout(() => {
      triggerRestart();
      updateInFlight = false;
    }, 1500);
  } catch (e) {
    updateResult = { status: 'error', channel, error: e.message, at: new Date().toISOString() };
    updateInFlight = false; // 失败则释放锁，允许重试
  }
}

// 更新状态查询（供前端轮询）
function handleUpdateResult(req, res) {
  sendJson(res, 200, updateResult || { status: 'idle' });
}

const server = http.createServer((req, res) => {
  // 只读端点免鉴权：状态查询、更新状态、更新结果
  if (req.method === 'GET' && req.url === '/api/status') return handleStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/update/status') return handleUpdateStatus(req, res);
  if (req.method === 'GET' && req.url === '/api/update/result') return handleUpdateResult(req, res);
  // 写操作必须带 token（fail-closed）
  if (!tokenMatches(req.headers['authorization'])) {
    sendJson(res, 401, {
      error: '未授权：缺少或错误的 API token（Authorization: Bearer <api_token>）',
      hint: '请在 addon 配置中设置 api_token，并在 deepseek_harness 集成中填入相同值',
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/update') return handleUpdate(req, res);
  if (req.method === 'POST' && req.url === '/api/session') return handleSession(req, res);
  if (req.method === 'POST' && req.url === '/api/restart') return handleRestart(req, res);
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[DSH Addon] Bridge API listening on 0.0.0.0:' + PORT);
});
