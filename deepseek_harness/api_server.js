'use strict';

/**
 * DeepSeek Harness add-on - stable bridge API.
 *
 * Exposes a small, version-stable HTTP API that the `deepseek_harness` HA
 * custom_component depends on. The custom_component NEVER talks to DSH's
 * volatile RC internals directly; it only calls this contract:
 *
 *   POST /api/chat    { message, session? }  -> { text }
 *   GET  /api/status                          -> { online, ... }
 *   POST /api/restart                         -> { ok }
 *
 * /api/chat drives DSH through `dsh --profile headless`, the stable
 * one-shot agent runner. Multi-turn session relay (via the web profile's
 * WebSocket) is a later upgrade that stays inside this file.
 */

const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.DSH_API_PORT || '3082', 10);
const DSH_BIN =
  process.env.DSH_BIN ||
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
const DSH_WEB_PORT = 3081;

function sendJson(res, code, obj) {
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

function runHeadless(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      ['--expose-internals', DSH_BIN, '--profile', 'headless', message],
      { env: process.env }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => reject(new Error('启动 DSH 失败: ' + e.message)));
    child.on('close', (code) => {
      const text = out.trim();
      if (code !== 0 && !text) {
        reject(new Error('DSH 退出码 ' + code + ': ' + err.slice(0, 500)));
      } else {
        resolve(text);
      }
    });
  });
}

async function handleChat(req, res) {
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

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET' && req.url === '/api/status') return handleStatus(req, res);
  if (req.method === 'POST' && req.url === '/api/restart') return handleRestart(req, res);
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[DSH Addon] Bridge API listening on 0.0.0.0:' + PORT);
});
