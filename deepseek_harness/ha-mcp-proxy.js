'use strict';

/**
 * Local loopback proxy: forwards requests to a Home Assistant MCP webhook
 * so it can be used by dsh-mcp-connector, which (for security) only accepts
 * https:// or loopback http:// URLs.
 *
 * dsh-mcp-connector's assertSafeUrl rejects plain http:// to non-loopback
 * hosts (e.g. http://homeassistant:8123). This proxy listens on 127.0.0.1
 * (loopback) and forwards to the real HA host/port, so the MCP server URL
 * can be configured as http://127.0.0.1:<LPORT>/... which passes validation.
 *
 * Environment:
 *   HA_MCP_PROXY_LISTEN  — listen port on 127.0.0.1 (default 8124)
 *   HA_MCP_PROXY_TARGET  — target host (default homeassistant)
 *   HA_MCP_PROXY_TPORT   — target port (default 8123)
 *
 * Also supports WebSocket upgrade (SSE/streamable-http keepalive).
 */

const http = require('http');
const net = require('net');

const LPORT = parseInt(process.env.HA_MCP_PROXY_LISTEN || '8124', 10);
const TARGET = process.env.HA_MCP_PROXY_TARGET || 'homeassistant';
const TPORT = parseInt(process.env.HA_MCP_PROXY_TPORT || '8123', 10);

const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    {
      host: TARGET,
      port: TPORT,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, {
        host: TARGET + ':' + TPORT,
      }),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('local proxy error: ' + e.message);
  });
  req.pipe(proxyReq);
});

// WebSocket upgrade (streamable-http uses SSE over a normal POST, but keep
// upgrade support for robustness).
server.on('upgrade', (req, socket) => {
  const proxySocket = net.connect(TPORT, TARGET, () => {
    proxySocket.write(
      'GET ' + req.url + ' HTTP/1.1\r\n' +
      'Host: ' + TARGET + ':' + TPORT + '\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: ' + (req.headers.upgrade || 'websocket') + '\r\n' +
      'Sec-WebSocket-Key: ' + (req.headers['sec-websocket-key'] || '') + '\r\n' +
      'Sec-WebSocket-Version: ' + (req.headers['sec-websocket-version'] || '13') + '\r\n\r\n'
    );
    socket.pipe(proxySocket).pipe(socket);
  });
  proxySocket.on('error', () => socket.destroy());
  socket.on('error', () => proxySocket.destroy());
});

server.listen(LPORT, '127.0.0.1', () => {
  console.log('[DSH Addon] HA MCP local proxy on 127.0.0.1:' + LPORT + ' -> ' + TARGET + ':' + TPORT);
});
