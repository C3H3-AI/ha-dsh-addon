'use strict';

/**
 * DeepSeek Harness add-on - stable bridge API.
 *
 * Exposes a small, version-stable HTTP API that the `deepseek_harness` HA
 * custom_component depends on. The custom_component NEVER talks to DSH's
 * volatile RC internals directly; it only calls this contract:
 *
 *   POST /api/chat    { message, session? }  -> { text }
 *   POST /api/session { message, session? }  -> { text, sessionId }
 *   GET  /api/status                          -> { online, ... }
 *   POST /api/restart                         -> { ok }
 *
 * /api/chat drives DSH through `dsh --profile headless`, the stable
 * one-shot agent runner.
 *
 * /api/session is the multi-turn session relay (path A): it talks to the
 * running web profile's Typert Remote RPC surface at 127.0.0.1:3081 over
 * plain HTTP POST /api/<endpoint> (session.create / session.list /
 * session.history / session.prompt), so the HA conversation keeps real
 * memory across turns and the reply streams back. The `sessionId` returned
 * is used as the HA conversation_id.
 */

const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.DSH_API_PORT || '3082', 10);
const DSH_BIN =
  process.env.DSH_BIN ||
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
const DSH_WEB_PORT = 3081;
// 共享密钥鉴权：由 run.sh 从 addon 配置 (api_token) 注入。
// 未配置时对写操作 fail-closed（401），防止容器网络内未授权调用触发 DSH 代码执行。
const API_TOKEN = process.env.DSH_API_TOKEN || '';
// 一键更新相关
const VENDOR_DIR = '/data/dsh/vendor';
const VENDOR_TMP = '/data/dsh/vendor.tmp';
const VENDOR_DSH_BIN = path.join(VENDOR_DIR, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
const CHAT_TIMEOUT_MS = 60 * 1000; // headless 单次调用上限 60s
let chatInFlight = false; // 单飞锁：同一时间只允许 1 个 headless 调用

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

function runHeadless(message, timeoutMs = CHAT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      ['--expose-internals', DSH_BIN, '--profile', 'headless', message],
      { env: process.env }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`DSH 调用超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('启动 DSH 失败: ' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code !== 0 && !text) {
        reject(new Error('DSH 退出码 ' + code + ': ' + err.slice(0, 500)));
      } else {
        resolve(text);
      }
    });
  });
}

// ---- 多轮会话中继（path A：DSH web 的 Typert Remote RPC）----
// 直接向运行中的 web profile（127.0.0.1:3081）发起 session 类 RPC。
// 无鉴权（本部署 web profile 未强制浏览器 cookie 认证，且走 loopback 通过
// Host/Origin 围栏）。请求/响应包络与 DSH 浏览器客户端一致：
//   请求 {type:'client-request', rpcId, method, payload}
//   响应 {type:'server-response', rpcId, result:{ok, value|error}}
const DSH_WEB_ORIGIN = 'http://127.0.0.1:' + DSH_WEB_PORT;

// 单次 DSH web RPC 调用。rpcId 可选，供 session.prompt 用作文本流关联键。
async function dshRpc(method, payload, rpcId) {
  const res = await fetch(DSH_WEB_ORIGIN + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: rpcId || 'dsh-bridge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method,
      payload,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error('DSH web ' + method + ' 返回 HTTP ' + res.status);
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
async function sessionBaselineSeq(sessionId) {
  const before = await dshRpc('session.history', { sessionId, maxMessages: 1 });
  return Math.max(-1, ...(before.events ?? []).map((e) => e.event?.seq ?? -1));
}

// 挑选或创建会话：有 session 则沿用；否则选最近活跃的非空白会话；再没有就新建。
async function resolveSession(sessionId) {
  if (typeof sessionId === 'string' && sessionId) {
    try {
      await dshRpc('session.history', { sessionId, maxMessages: 1 });
      return sessionId; // 存在则沿用
    } catch {
      // session-not-found 或已失效 -> 落到新建
    }
  }
  try {
    const list = await dshRpc('session.list', {});
    const items = list?.items ?? [];
    // 优先非空白、非 running 的最近会话（updatedAt 降序）
    const candidate = items
      .filter((it) => it && it.sessionId && it.blank !== true && it.running !== true)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (candidate) return candidate.sessionId;
  } catch {
    // list 失败则直接新建
  }
  const created = await dshRpc('session.create', {});
  return created.sessionId;
}

// 从一条会话事件里抽取助手文本（assistant/message 的 content 中的 text 段）
function assistantText(ev) {
  return (ev?.data?.message?.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// 多轮中继：prompt 后轮询 session.history，按 promptRpcId 关联并累计助手文本，
// 到 turn/end 结束。超时抛错。
async function relaySession(message, sessionId, timeoutMs = 120_000) {
  const baselineSeq = await sessionBaselineSeq(sessionId);
  const promptRpcId = 'dsh-bridge-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  await dshRpc('session.prompt', {
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
      hist = await dshRpc('session.history', { sessionId, maxMessages: 100 });
    } catch (e) {
      // 轮询瞬时失败则继续，直到超时
      continue;
    }
    const events = (hist.events ?? [])
      .map((e) => e.event)
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

async function handleChat(req, res) {
  // 单飞锁：headless 是重进程，同一时间只允许 1 个调用
  if (chatInFlight) {
    sendJson(res, 429, { text: 'DSH 正在处理上一条请求，请稍后再试' });
    return;
  }
  chatInFlight = true;
  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const message = (body.message || '').toString();
    if (!message) {
      sendJson(res, 400, { text: '缺少 message 字段' });
      return;
    }
    const text = await runHeadless(message);
    sendJson(res, 200, { text });
  } catch (e) {
    sendJson(res, 502, { text: 'DSH 调用失败: ' + e.message });
  } finally {
    chatInFlight = false;
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
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && req.url === '/api/session') return handleSession(req, res);
  if (req.method === 'POST' && req.url === '/api/restart') return handleRestart(req, res);
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[DSH Addon] Bridge API listening on 0.0.0.0:' + PORT);
});
