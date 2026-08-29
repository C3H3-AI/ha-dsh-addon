#!/usr/bin/env node

/**
 * Mock DSH web profile (Typert Remote RPC over HTTP) for contract testing.
 *
 * Serves the endpoints the addon bridge uses:
 *   workspace.list  -> one workspace
 *   session.create  -> new session id (registers to the workspace)
 *   session.list    -> known sessions
 *   session.history -> events; after a prompt, plays a turn lifecycle
 *   session.prompt  -> {accepted:true} and schedules a turn
 *
 * Messages starting with "slow:" make the turn take longer than the relay
 * timeout, so the test can assert timeout behaviour.
 */

const http = require('http');

const PORT = parseInt(process.env.MOCK_DSH_PORT || '3099', 10);
const WORKSPACE_ID = 'ws-mock-0001';
const sessions = new Map(); // id -> { seq, events: [], pending: null }
let counter = 0;

function pushEvent(session, type, data) {
    session.seq += 1;
    session.events.push({ type, seq: session.seq, time: Date.now(), data });
}

function ensureSession(id) {
    if (!sessions.has(id)) {
        sessions.set(id, { seq: 0, events: [], pending: null });
        pushEvent(sessions.get(id), 'permission/preset', { preset: 'workspace-write' });
    }
    return sessions.get(id);
}

function startTurn(session, text, requestId, slow) {
    pushEvent(session, 'turn/start', { turn: 1 });
    pushEvent(session, 'user/message', {
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: requestId },
    });
    const delay = slow ? 5000 : 10;
    session.pending = setTimeout(() => {
        pushEvent(session, 'assistant/message', {
            role: 'assistant',
            message: { content: [{ type: 'text', text: `mock reply: ${text}` }] },
            turn: 1,
        });
        pushEvent(session, 'turn/end', { turn: 1 });
        session.pending = null;
    }, delay);
}

function handle(method, payload, rpcId) {
    switch (method) {
        case 'workspace.list':
            return { items: [{ workspaceId: WORKSPACE_ID, path: '/mock/workspace', sessionIds: [...sessions.keys()] }], archivedSessionIds: [] };
        case 'session.create': {
            const id = payload.sessionId || `session-mock-${String(++counter)}`;
            ensureSession(id);
            return { sessionId: id, agentPreset: 'standard' };
        }
        case 'session.list':
            return {
                items: [...sessions.keys()].map((sessionId) => ({
                    sessionId, blank: false, running: false, updatedAt: Date.now(),
                    cwd: '/mock/workspace', projections: { values: { title: 'mock' } },
                })),
            };
        case 'session.history': {
            const session = sessions.get(payload.sessionId);
            if (!session) { const e = new Error('session not found'); e.code = 'session-not-found'; throw e; }
            return { events: session.events.map((event) => ({ event })), hasMore: false, projections: { values: {} } };
        }
        case 'session.prompt': {
            const session = ensureSession(payload.sessionId);
            const text = (payload.content || []).map((c) => c.text).join('');
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
            const value = handle(msg.method, msg.payload || {}, msg.rpcId);
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
