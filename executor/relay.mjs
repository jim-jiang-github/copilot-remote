import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { token } from './wire.mjs';

const roles = ['agent', 'device', 'operator'];
const routes = {
  agent: { request: 'device', reply: 'operator', event: 'operator' },
  device: { reply: 'agent', event: 'agent' },
  operator: { request: 'agent' },
};

export function createRelay({ secrets, host = '127.0.0.1', port = 8788 }) {
  for (const role of roles) token(secrets[role]);
  if (new Set(Object.values(secrets)).size !== 3) throw new Error('Role tokens must be distinct');
  const server = createServer((request, response) => {
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const peers = new Map();
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) socket.terminate();
    else socket.send(JSON.stringify(message));
  };
  const presence = () => {
    for (const socket of peers.values()) send(socket, { type: 'presence', roles: [...peers.keys()] });
  };
  server.on('upgrade', (request, socket, head) => {
    const role = request.headers['x-executor-role'];
    const expected = secrets[role];
    const actual = request.headers.authorization?.replace(/^Bearer /, '');
    if (request.url !== '/' || request.headers.origin || !roles.includes(role)
      || !expected || typeof actual !== 'string'
      || Buffer.byteLength(actual) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (peers.has(role)) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      peers.set(role, ws);
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => ws.terminate());
      presence();
      ws.on('message', (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { ws.close(1002); return; }
        if (!message || message.to !== routes[role][message.type]
          || !['request', 'reply', 'event'].includes(message.type)
          || (message.type !== 'event' && (typeof message.id !== 'string'
            || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id)))) {
          ws.close(1008, 'Role routing violation');
          return;
        }
        const destination = peers.get(message.to);
        if (!destination) {
          if (message.type === 'request') send(ws, {
            type: 'reply', from: message.to, id: message.id, error: `${message.to} is offline`,
          });
          return;
        }
        send(destination, { ...message, from: role });
      });
      ws.on('close', () => {
        if (peers.get(role) === ws) peers.delete(role);
        presence();
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of peers.values()) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 15_000);
  heartbeat.unref();
  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of peers.values()) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function main() {
  const relay = createRelay({
    secrets: {
      agent: process.env.EXECUTOR_AGENT_TOKEN,
      device: process.env.EXECUTOR_DEVICE_TOKEN,
      operator: process.env.EXECUTOR_OPERATOR_TOKEN,
    },
    host: process.env.EXECUTOR_BIND || '127.0.0.1',
    port: Number(process.env.EXECUTOR_PORT || 8788),
  });
  const address = await relay.start();
  console.log(`Executor relay listening on ${address.address}:${address.port}; TLS reverse proxy required for public use`);
  const stop = () => relay.close().catch((error) => { console.error(error); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
