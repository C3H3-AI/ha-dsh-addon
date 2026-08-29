'use strict';

/**
 * Bridge API contract tests.
 *
 * Starts the api_server.js in a subprocess against a mock DSH web profile,
 * then asserts the stable contract:
 *   - GET  /api/status        (public)
 *   - POST /api/session       (auth, multi-turn relay, single-flight)
 *
 * Usage:
 *   node tests/test_bridge_api.js
 *
 * Environment:
 *   DSH_API_PORT=3099      (bridge port)
 *   MOCK_DSH_PORT=3098     (mock DSH web RPC port)
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.DSH_API_PORT || '3099', 10);
const MOCK_PORT = parseInt(process.env.MOCK_DSH_PORT || '3098', 10);
const API_SERVER = path.join(__dirname, '..', 'deepseek_harness', 'api_server.js');
const MOCK_DSH_WEB = path.join(__dirname, 'mock_dsh_web.js');

const TEST_TOKEN = 'test-secret-123';

// ---- helpers ----

function fetch(method, urlPath, opts = {}) {
    return new Promise((resolve, reject) => {
        const body = opts.body ? JSON.stringify(opts.body) : undefined;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        const req = http.request(
            { hostname: '127.0.0.1', port: PORT, path: urlPath, method, headers },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch (_) { /* ignore */ }
                    resolve({ status: res.statusCode, headers: res.headers, body: data, json });
                });
            }
        );
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}  ${detail || ''}`);
        failed++;
    }
}

async function run() {
    console.log(`\nBridge API Contract Tests (bridge ${PORT}, mock dsh ${MOCK_PORT})\n`);

    if (!fs.existsSync(MOCK_DSH_WEB)) {
        console.error('  ✗ mock_dsh_web.js not found at', MOCK_DSH_WEB);
        process.exit(1);
    }

    // ---- start mock DSH web profile ----
    const mock = spawn('node', [MOCK_DSH_WEB], {
        env: Object.assign({}, process.env, { MOCK_DSH_PORT: String(MOCK_PORT) }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let mockLog = '';
    mock.stdout.on('data', (d) => { mockLog += d.toString(); });
    mock.stderr.on('data', (d) => { mockLog += d.toString(); });

    // ---- start api_server.js pointing at the mock ----
    const env = Object.assign({}, process.env, {
        DSH_API_PORT: String(PORT),
        DSH_API_TOKEN: TEST_TOKEN,
        DSH_WEB_PORT: String(MOCK_PORT),
    });
    const server = spawn('node', [API_SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    await sleep(800);

    try {
        // ===== 1. GET /api/status (public) =====.
        console.log('1. GET /api/status (public, no auth required)');
        {
            const r = await fetch('GET', '/api/status');
            assert('returns 200', r.status === 200, `got ${r.status}`);
            assert('has online field', r.json && typeof r.json.online !== 'undefined', r.body);
        }

        // ===== 2. POST /api/session without token =====.
        console.log('2. POST /api/session without token (should 401)');
        {
            const r = await fetch('POST', '/api/session', { body: { message: 'hello' } });
            assert('returns 401', r.status === 401, `got ${r.status}`);
        }

        // ===== 3. POST /api/session with wrong token =====.
        console.log('3. POST /api/session with wrong token (should 401)');
        {
            const r = await fetch('POST', '/api/session', {
                body: { message: 'hello' },
                headers: { Authorization: 'Bearer wrong-token' },
            });
            assert('returns 401', r.status === 401, `got ${r.status}`);
        }

        // ===== 4. POST /api/session with correct token =====.
        console.log('4. POST /api/session with correct token (multi-turn relay)');
        let sessionId = null;
        {
            const r = await fetch('POST', '/api/session', {
                body: { message: 'hello world' },
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            assert('returns 200', r.status === 200, `got ${r.status} body=${r.body}`);
            assert('has text', r.json && typeof r.json.text === 'string', r.body);
            assert('reply echoes the prompt', r.json && /hello world/.test(r.json.text), r.body);
            assert('has sessionId', r.json && typeof r.json.sessionId === 'string', r.body);
            sessionId = r.json && r.json.sessionId;
        }

        // ===== 5. second turn reuses the same session =====.
        console.log('5. POST /api/session second turn reuses conversation_id');
        {
            const r = await fetch('POST', '/api/session', {
                body: { message: 'second turn', session: sessionId },
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            assert('returns 200', r.status === 200, `got ${r.status}`);
            assert('same sessionId returned', r.json && r.json.sessionId === sessionId, r.body);
        }

        // ===== 6. empty message -> 400 =====.
        console.log('6. POST /api/session with empty message');
        {
            const r = await fetch('POST', '/api/session', {
                body: { message: '' },
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            assert('returns 400', r.status === 400, `got ${r.status}`);
        }

        // ===== 7. single-flight lock =====.
        console.log('7. POST /api/session concurrent (single-flight lock)');
        {
            const [a, b] = await Promise.all([
                fetch('POST', '/api/session', {
                    body: { message: 'slow: first' },
                    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                }),
                fetch('POST', '/api/session', {
                    body: { message: 'second' },
                    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                }),
            ]);
            const codes = [a.status, b.status].sort();
            assert('one request is rejected with 429', codes.includes(429), `codes=${codes.join(',')}`);
        }
    } catch (e) {
        console.log(`  ✗ run aborted: ${e.message}`);
        failed++;
        server.kill();
        mock.kill();
    }

    if (serverLog.trim()) console.log('--- api_server log ---\n' + serverLog);
    if (mockLog.trim()) console.log('--- mock log ---\n' + mockLog);
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        if (serverLog.trim()) console.log('--- api_server log ---\n' + serverLog);
        if (mockLog.trim()) console.log('--- mock log ---\n' + mockLog);
        process.exit(1);
    }
    process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
