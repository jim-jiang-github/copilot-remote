import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function desktopBridge(request) {
  return Promise.reject(new AppError(503, 'BACKGROUND_API_UNAVAILABLE', 'Controller disabled: no supported focus-free App delivery API has been verified.'));
}

function equalSecret(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

async function readJson(req) {
  if (req.headers['content-type'] !== 'application/json') throw new AppError(415, 'CONTENT_TYPE', 'Use application/json.');
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 40000) throw new AppError(413, 'TOO_LARGE', 'Request is too large.');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new AppError(400, 'INVALID_JSON', 'Invalid JSON request.'); }
}

export function createController({ password, username = 'local', account, origin, bridge = desktopBridge, tls, now = Date.now }) {
  const expected = new URL(origin);
  if (!['http:', 'https:'].includes(expected.protocol) || expected.origin !== origin) throw new Error('Origin must be an exact HTTP(S) origin without a path.');
  if (!account && (typeof password !== 'string' || password.length < 24)) throw new Error('Controller password must be at least 24 characters.');
  const logins = new Map();
  const attempts = new Map();
  const requests = new Map();
  let busy = false;
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== expected.host) throw new AppError(403, 'HOST_DENIED', 'Host is not configured for this controller.');
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === 'GET' && assets.has(route)) {
        const [name, contentType] = assets.get(route);
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(await readFile(path.join(root, 'public', name)));
      }
      if (!route.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not trusted.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'ORIGIN_DENIED', 'Cross-site request denied.');
      for (const [key, value] of logins) if (value.expires <= now()) logins.delete(key);
      for (const [key, value] of attempts) if (value.reset <= now()) attempts.delete(key);
      for (const [key, value] of requests) if (value.expires <= now() && value.done) requests.delete(key);
      if (route === '/api/account' && req.method === 'GET') {
        return json(200, account ? await account.status() : { needsSetup: false });
      }
      if (route === '/api/setup' && req.method === 'POST') {
        const address = req.socket.remoteAddress;
        if (!account || expected.origin !== 'http://127.0.0.1:8765' ||
            !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(address)) throw new AppError(403, 'LOCAL_SETUP_ONLY', '首次账号创建只允许在电脑本机 http://127.0.0.1:8765 完成。');
        if (!(await account.status()).needsSetup) throw new AppError(409, 'ACCOUNT_EXISTS', '本地账号已配置。');
        const data = await readJson(req);
        try { await account.setup(data?.username, data?.password); }
        catch (error) { throw new AppError(400, 'ACCOUNT_SETUP_FAILED', error.code === 'EEXIST' ? '本地账号已配置。' : '账号需为1-64位字母数字、点、下划线或横线，密码至少12位；无法保存时请检查本地配置目录。'); }
        return json(200, { configured: true });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) ?? { count: 0, reset: now() + 600000 };
        if (attempt.count >= 5) throw new AppError(429, 'LOGIN_LIMIT', 'Too many login attempts. Wait 10 minutes.');
        const data = await readJson(req);
        const valid = account ? await account.authenticate(data?.username, data?.password) :
          data?.username === username && typeof data?.password === 'string' && equalSecret(data.password, password);
        if (!valid) {
          attempt.count++;
          attempts.set(ip, attempt);
          throw new AppError(401, 'LOGIN_FAILED', '本地账号或密码不正确。不要输入 GitHub 密码。');
        }
        if (logins.size >= 64) throw new AppError(429, 'LOGIN_LIMIT', 'Too many active logins.');
        const token = randomBytes(32).toString('hex');
        logins.set(token, { expires: now() + 12 * 3600000 });
        res.setHeader('Set-Cookie', `remote_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${expected.protocol === 'https:' ? '; Secure' : ''}`);
        return json(200, { authenticated: true });
      }
      const cookie = req.headers.cookie?.match(/(?:^|; )remote_session=([0-9a-f]{64})(?:;|$)/)?.[1];
      if (account && (await account.status()).needsSetup) logins.clear();
      if (!cookie || !logins.has(cookie)) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to connect to the desktop.');
      if (route === '/api/logout' && req.method === 'POST') {
        logins.delete(cookie);
        res.setHeader('Set-Cookie', 'remote_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(200, { authenticated: false });
      }
      let operation;
      let requestId;
      if (route === '/api/history' && req.method === 'POST') {
        const data = await readJson(req);
        if (!uuid.test(data?.id ?? '') || Object.keys(data).some(key => !['id', 'before', 'after'].includes(key))) throw new AppError(400, 'INVALID_HISTORY', 'Invalid history request.');
        const result = await bridge({ action: 'history', id: data.id, before: data.before, after: data.after });
        return json(200, { ok: true, ...result });
      }
      if (route === '/api/snapshot' && req.method === 'GET') operation = { action: 'snapshot' };
      else if ((route === '/api/select' || route === '/api/send') && req.method === 'POST') {
        const data = await readJson(req);
        if (!uuid.test(data?.id ?? '')) throw new AppError(400, 'INVALID_TARGET', 'Invalid session ID.');
        operation = { action: route === '/api/send' ? 'send' : 'select', id: data.id };
        if (operation.action === 'send') {
          if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000 || data.text.includes('\0')) throw new AppError(400, 'INVALID_TEXT', 'Enter 1-8000 characters without NUL.');
          if (!uuid.test(data.requestId ?? '')) throw new AppError(400, 'INVALID_REQUEST_ID', 'A unique request ID is required.');
          operation.text = data.text;
          requestId = data.requestId;
          operation.requestId = requestId;
          const existing = requests.get(requestId);
          if (existing) {
            if (existing.cookie !== cookie || existing.id !== data.id || existing.text !== data.text) throw new AppError(409, 'REQUEST_CONFLICT', 'Request ID was already used for another message.');
            if (!existing.done) throw new AppError(409, 'DELIVERY_PENDING', 'This message is already being processed. Do not resend.');
            return json(existing.status, existing.body);
          }
        }
      } else if (route === '/api/targets' && req.method === 'POST') {
        await readJson(req);
        operation = { action: 'targets' };
      } else if (route === '/api/create' && req.method === 'POST') {
        const data = await readJson(req);
        if (typeof data?.name !== 'string' || !data.name.trim() || data.name.length > 80 ||
            !uuid.test(data.requestId ?? '') || (data.projectId !== null && !uuid.test(data.projectId ?? ''))) {
          throw new AppError(400, 'INVALID_CREATE', '请输入1-80位会话名，并选择真实项目或独立聊天。');
        }
        operation = { action: 'create', name: data.name.trim(), projectId: data.projectId, requestId: data.requestId };
      } else throw new AppError(404, 'NOT_FOUND', 'Not found.');
      if (busy) throw new AppError(409, 'BUSY', 'Another desktop operation is in progress.');
      if (requestId && requests.size >= 1000) throw new AppError(429, 'SEND_LIMIT', 'Message receipt capacity reached. Try again later.');
      busy = true;
      const record = requestId ? { cookie, id: operation.id, text: operation.text, done: false, expires: now() + 12 * 3600000 } : null;
      if (record) requests.set(requestId, record);
      try {
        const result = await bridge(operation);
        const body = { ok: true, ...result };
        if (record) Object.assign(record, { done: true, status: 200, body });
        return json(200, body);
      } catch (error) {
        const status = error instanceof AppError ? error.status : 503;
        const body = { ok: false, connected: false, code: error instanceof AppError ? error.code : 'BRIDGE_FAILED', error: error instanceof AppError ? error.message : 'Desktop operation failed.' };
        if (record) Object.assign(record, { done: true, status, body });
        return json(status, body);
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) json(error instanceof AppError ? error.status : 500, { ok: false, code: error instanceof AppError ? error.code : 'SERVER_ERROR', error: error instanceof AppError ? error.message : 'Controller request failed.' });
      else res.end();
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  throw new Error('Start this controller through remote_relay_start in the dedicated App coordinator, not an independent CLI. Desktop automation is disabled.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
