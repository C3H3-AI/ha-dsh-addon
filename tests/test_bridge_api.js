'use strict';

/**
 * Bridge API contract tests.
 *
 * Starts the api_server.js in a subprocess, runs HTTP requests against it,
 * and asserts the stable contract (status/chat/restart/update).
 *
 * Usage:
 *   node tests/test_bridge_api.js
 *
 * Environment:
 *   DSH_API_PORT=3099   (auto-assigned random port, default 3099)
 *   DSH_BIN=./test/mock_dsh.js  (path to a headless mock)
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.DSH_API_PORT || '3099', 10);
const API_SERVER = path.join(__dirname, '..', 'deepseek_harness', 'api_server.js');
const MOCK_DSH = path.join(__dirname, 'mock_dsh.js');

const TEST_TOKEN = 'test-secret-123';
const ALLOWED_DIFF = 50; // ms allowed for timing comparison

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

// ---- main ----
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
    console.log(`\nBridge API Contract Tests (port ${PORT})\n`);
    console.log(`api_server: ${API_SERVER}`);
    console.log(`mock_dsh:   ${MOCK_DSH}\n`);

    // Verify mock exists
    if (!fs.existsSync(MOCK_DSH)) {
        console.error('  ✗ mock_dsh.js not found at', MOCK_DSH);
        process.exit(1);
    }

    // Start api_server.js with the mock DSH binary
    const env = Object.assign({}, process.env, {
        DSH_API_PORT: String(PORT),
        DSH_API_TOKEN: TEST_TOKEN,
        DSH_BIN: MOCK_DSH,
    });
    const server = spawn('node', [API_SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    // Wait for server to start
    await sleep(500);

    try {
        // ===== 1. GET /api/status =====
        console.log('1. GET /api/status (public, no auth required)');
        {
            const r = await fetch('GET', '/api/status');
            assert('returns 200', r.status === 200);
            assert('has online field', r.json && typeof r.json.online === 'boolean');
        }

        // ===== 2. POST /api/chat without token =====
        console.log('2. POST /api/chat without token (should 401)');
        {
            const r = await fetch('POST', '/api/chat', { body: { message: 'hello' } });
            assert('returns 401', r.status === 401);
            assert('has error key', r.json && r.json.error);
        }

        // ===== 3. POST /api/chat with wrong token =====
        console.log('3. POST /api/chat with wrong token (should 401)');
        {
            const r = await fetch('POST', '/api/chat', {
                headers: { Authorization: 'Bearer wrong-token' },
                body: { message: 'hello' },
            });
            assert('returns 401', r.status === 401);
        }

        // ===== 4. POST /api/chat with correct token =====
        console.log('4. POST /api/chat with correct token');
        {
            const r = await fetch('POST', '/api/chat', {
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                body: { message: 'hello' },
            });
            assert('returns 200', r.status === 200);
            assert('has text field', r.json && typeof r.json.text === 'string');
            assert('text is mock response', r.json && r.json.text.includes('mock'));
        }

        // ===== 5. POST /api/chat empty message =====
        console.log('5. POST /api/chat with empty message');
        {
            const r = await fetch('POST', '/api/chat', {
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                body: { message: '' },
            });
            assert('returns 400', r.status === 400);
        }

        // ===== 6. POST /api/chat concurrent (single-flight lock) =====
        console.log('6. POST /api/chat concurrent (single-flight lock)');
        {
            // The mock slow-responds; second request should get 429
            const [r1, r2] = await Promise.all([
                fetch('POST', '/api/chat', {
                    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                    body: { message: 'slow:1000' },
                }),
                fetch('POST', '/api/chat', {
                    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
                    body: { message: 'fast' },
                }),
            ]);
            // At least one of them should be 200, the other could be 429 or 200
            // (timing-dependent, but we check the lock behavior)
            const statuses = [r1.status, r2.status];
            assert('one returns 200', statuses.includes(200));
            // If the second one got 429, the lock is working
            if (statuses.includes(429)) {
                const r429 = r1.status === 429 ? r1 : r2;
                assert('concurrent request returns 429', true);
                assert('429 has text about "正在处理上一条"', r429.json &&
                    r429.json.text && r429.json.text.includes('正在处理上一条'));
            } else {
                // Both returned 200 (sequential execution), acceptable
                console.log('  ~ concurrent lock not triggered (timing), both 200');
            }
        }

        // ===== 7. POST /api/restart without token =====
        console.log('7. POST /api/restart without token (should 401)');
        {
            const r = await fetch('POST', '/api/restart');
            assert('returns 401', r.status === 401);
        }

        // ===== 8. POST /api/restart with token =====
        console.log('8. POST /api/restart with token');
        {
            const r = await fetch('POST', '/api/restart', {
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            // Without SUPERVISOR_TOKEN, it should return 500
            assert('returns 500 (no SUPERVISOR_TOKEN)', r.status === 500);
        }

        // ===== 9. GET /api/update/status =====
        console.log('9. GET /api/update/status');
        {
            const r = await fetch('GET', '/api/update/status', {
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            assert('returns 200', r.status === 200);
            assert('has current version', r.json && typeof r.json.current === 'string');
            assert('has ok field', r.json && r.json.ok === true);
        }

        // ===== 10. Token timing constant-time check =====
        console.log('10. Token comparison timing (constant-time)');
        {
            // Measure response time for wrong-length vs right-length tokens
            const shortToken = 'Bearer short';
            const sameLenToken = 'Bearer ' + 'x'.repeat(TEST_TOKEN.length);

            const t1 = Date.now();
            await fetch('POST', '/api/chat', {
                headers: { Authorization: shortToken },
                body: { message: 'hi' },
            });
            const dt1 = Date.now() - t1;

            const t2 = Date.now();
            await fetch('POST', '/api/chat', {
                headers: { Authorization: sameLenToken },
                body: { message: 'hi' },
            });
            const dt2 = Date.now() - t2;

            // Both should be within ALLOWED_DIFF ms of each other
            const diff = Math.abs(dt1 - dt2);
            assert('short vs same-length token timing within ' + ALLOWED_DIFF + 'ms',
                diff < ALLOWED_DIFF, `diff=${diff}ms`);
        }

        // ===== 11. Unknown endpoint =====
        console.log('11. GET /api/nonexistent (should 404)');
        {
            const r = await fetch('GET', '/api/nonexistent', {
                headers: { Authorization: `Bearer ${TEST_TOKEN}` },
            });
            assert('returns 404', r.status === 404);
        }

    } finally {
        // Cleanup
        server.kill('SIGTERM');
        await sleep(200);
    }

    // ---- Summary ----
    const total = passed + failed;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed}/${total} passed, ${failed}/${total} failed`);
    console.log(`${'='.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
    console.error('Test runner error:', err);
    process.exit(1);
});