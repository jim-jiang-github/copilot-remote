import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export function relayUrl(value) {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Relay URL must contain only scheme, host and port');
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Non-loopback relay connections require wss://');
  }
  return url.href;
}

export function token(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(value)) {
    throw new Error('Use a random token of at least 32 bytes, encoded as base64url');
  }
  return value;
}

export class Peer extends EventEmitter {
  constructor({ url, role, secret, timeout = 360_000 }) {
    super();
    this.url = relayUrl(url);
    this.role = role;
    this.secret = token(secret);
    this.timeout = timeout;
    this.pending = new Map();
    this.closed = false;
    this.ready = false;
    this.generation = 0;
    this.peers = [];
  }

  connect() {
    if (this.closed) return;
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.secret}`, 'X-Executor-Role': this.role },
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    let lastMessage = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > 45_000) socket.terminate();
    }, 10_000);
    socket.on('ping', () => { lastMessage = Date.now(); });
    socket.on('message', (bytes) => {
      lastMessage = Date.now();
      let message;
      try { message = JSON.parse(bytes.toString()); } catch {
        this.emit('fault', new Error('Invalid relay message'));
        socket.close(1002);
        return;
      }
      if (message.type === 'presence') {
        const previous = this.peers;
        this.peers = message.roles;
        if (!this.ready) {
          this.ready = true;
          this.generation++;
          this.emit('ready');
        }
        for (const role of previous) {
          if (!this.peers.includes(role)) this.rejectPending(role);
        }
        this.emit('presence', this.peers);
      } else if (message.type === 'reply') {
        const pending = this.pending.get(message.id);
        if (pending && pending.to === message.from) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        }
      } else {
        this.emit('message', message);
      }
    });
    socket.on('error', (error) => this.emit('fault', error));
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.ready = false;
      this.peers = [];
      this.rejectPending();
      this.emit('disconnected');
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
  }

  rejectPending(role) {
    for (const [id, pending] of this.pending) {
      if (!role || pending.to === role) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Connection lost; request ${id} may have executed. It will NOT be replayed.`));
        this.pending.delete(id);
      }
    }
  }

  send(message) {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay disconnected');
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) {
      this.socket.terminate();
      throw new Error('Slow connection closed; delivery uncertain');
    }
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Message exceeds relay limit of 2 MiB');
    this.socket.send(text);
  }

  request(to, command, id = randomUUID()) {
    if (!this.peers.includes(to)) return Promise.reject(new Error(`${to} is offline; request not sent`));
    if (this.pending.has(id)) return Promise.reject(new Error('Request ID already in flight'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} timed out; delivery uncertain. No automatic retry.`));
      }, command?.action === 'cancel' ? Math.min(this.timeout, 10_000) : this.timeout);
      this.pending.set(id, { to, resolve, reject, timer });
      try { this.send({ type: 'request', to, id, command }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async respond(message, handler) {
    let reply;
    try { reply = { result: await handler(message.command) }; }
    catch (error) { reply = { error: error.message }; }
    try { this.send({ type: 'reply', to: message.from, id: message.id, ...reply }); }
    catch (error) { this.emit('fault', error); }
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.rejectPending();
    this.socket?.terminate();
  }
}
