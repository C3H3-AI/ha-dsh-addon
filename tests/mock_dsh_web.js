#!/usr/bin/env node

/**
 * Mock DSH web profile (Typert Remote RPC over HTTP) for contract testing.
 *
 * Mirrors the DSH 0.1.2-rc.1 wire contract the addon bridge relies on:
 *   - endpoints are <ns>/<method> (the bridge converts dotted methods to slashes)
 *   - request envelope:  {type:'client-request', rpcId, method, payload:{args:{request|_request}}}
 *   - response envelope: {type:'server-response', rpcId, result:{ok, value|error}}
 *   - session.list items carry projections.asOfSeq (backwards-paging baseline)
 *   - session.page {address:{sessionId}, throughSeq, maxMessages} -> {records:[{event}]}
 *   - event flow after session.prompt:
 *       agent/inbox/spliced (inserted[].source.rpcId == prompt rpcId)
 *       -> turn/start -> assistant/chunk(text-delta)... -> turn/end
 *
 * Messages starting with "slow:" delay the reply by 5s, so tests can assert
 * timeout / single-flight behaviour.
 */

const http = require('http');

const PORT = parseInt(process.env.MOCK_DSH_PORT || '3098', 10);
const WORKSPACE_ID = 'ws-mock-0001';
const sessions = new Map(); // id -> { seq, turn, events: [], pending: null }
let counter = 0;

function pushEvent(session, type, data) {
    session.seq += 1;
    session.events.push({ type, seq: session.seq, time: Date.now(), data });
}

function ensureSession(id) {
    if (!sessions.has(id)) {
        sessions.set(id, { seq: 0, turn: 0, events: [], pending: null });
        pushEvent(sessions.get(id), 'permission/preset', { preset: 'workspace-write' });
    }
    return sessions.get(id);
}

function startTurn(session, text, requestId, slow) {
    session.turn += 1;
    const turn = session.turn;
    // rc.1 事件流没有 user/message：用户消息内嵌在 agent/inbox/spliced 的
    // inserted[]（source.rpcId 关联 prompt 的 wire rpcId / requestId）。
    pushEvent(session, 'agent/inbox/spliced', {
        inserted: [{ source: { kind: 'user', rpcId: requestId }, message: { content: [{ type: 'text', text }] } }],
    });
    pushEvent(session, 'turn/start', { turn });
    const delay = slow ? 5000 : 10;
    session.pending = setTimeout(() => {
        pushEvent(session, 'assistant/chunk', {
            turn,
            step: 0,
            chunk: { type: 'text-delta', index: 0, text: `mock reply: ${text}` },
        });
        pushEvent(session, 'turn/end', { turn });
        session.pending = null;
    }, delay);
}

function handle(method, payload, rpcId) {
    // bridge 包装：payload = { args: { request: {...} } }，session.list 用 _request
    const args = (payload && payload.args) || {};
    const request = args.request ?? args._request ?? {};
    switch (method) {
        case 'workspace.list':
            return { items: [{ workspaceId: WORKSPACE_ID, path: '/mock/workspace', sessionIds: [...sessions.keys()] }], archivedSessionIds: [] };
        case 'session.create': {
            const id = request.sessionId || `session-mock-${String(++counter)}`;
            ensureSession(id);
            return { sessionId: id, agentPreset: 'standard' };
        }
        case 'session.list':
            return {
                items: [...sessions.keys()].map((sessionId) => {
                    const s = sessions.get(sessionId);
                    return {
                        sessionId, blank: false, running: false, updatedAt: Date.now(),
                        cwd: '/mock/workspace',
                        projections: { values: { title: 'mock' }, asOfSeq: s.seq },
                    };
                }),
            };
        case 'session.page': {
            const sessionId = request.address && request.address.sessionId;
            const session = sessions.get(sessionId);
            if (!session) { const e = new Error('session not found'); e.code = 'session-not-found'; throw e; }
            const throughSeq = typeof request.throughSeq === 'number' ? request.throughSeq : session.seq;
            const records = session.events
                .filter((ev) => ev.seq <= throughSeq)
                .map((event) => ({ event }));
            return { records, hasMore: false, projections: { values: {} } };
        }
        case 'session.prompt': {
            const session = ensureSession(request.sessionId);
            const text = (request.content || []).map((c) => c.text).join('');
            startTurn(session, text, rpcId, String(text).startsWith('slow:'));
            return { accepted: true };
        }
        default:
            return {};
    }
}

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        let out;
        try {
            const msg = JSON.parse(body || '{}');
            // 桥接层把点号方法转成斜杠 endpoint（session.list -> /api/session/list），
            // msg.method 即斜杠形态；统一归一化回点号便于分发。
            const method = String(msg.method || '').replace(/\//g, '.');
            const value = handle(method, msg.payload || {}, msg.rpcId);
            out = { type: 'server-response', rpcId: msg.rpcId, result: { ok: true, value } };
        } catch (e) {
            out = {
                type: 'server-response',
                rpcId: 'err',
                result: { ok: false, error: { code: e.code || 'internal', message: e.message, details: {} } },
            };
        }
        const text = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`mock dsh web listening on ${PORT}`);
});
