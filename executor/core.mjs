import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveJson } from './storage.mjs';

export class ExecutorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new ExecutorError('Invalid identifier');
  }
  return value;
}

export class Executor extends EventEmitter {
  constructor({ client, directory, workspace, reviewTimeout = 300_000,
    sessionConfig = () => ({}), onAbort = async () => {} }) {
    super();
    this.client = client;
    this.directory = resolve(directory);
    this.workspace = resolve(workspace);
    this.reviewTimeout = reviewTimeout;
    this.sessionConfig = sessionConfig;
    this.onAbort = onAbort;
    this.catalog = { sessions: {}, operations: {} };
    this.sessions = new Map();
    this.reviews = new Map();
    this.events = [];
    this.epoch = randomUUID();
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.closing = false;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.catalog = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async persist() {
    const path = join(this.directory, 'catalog.json');
    await saveJson(path, this.catalog);
  }

  publish(sessionId, type, data) {
    const event = { epoch: this.epoch, sequence: ++this.sequence, sessionId, type, data };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    this.emit('event', event);
  }

  review(sessionId, type, request) {
    if (this.closing) {
      return type === 'permission'
        ? Promise.resolve({ kind: 'reject', feedback: 'Executor is stopping' })
        : Promise.reject(new Error('Executor is stopping'));
    }
    const size = Buffer.byteLength(JSON.stringify(request));
    const pendingSize = [...this.reviews.values()]
      .reduce((total, review) => total + Buffer.byteLength(JSON.stringify(review.request)), 0);
    if (size > 400 * 1024 || pendingSize + size > 850 * 1024 || this.reviews.size >= 16) {
      const message = 'Review payload/queue limit exceeded; no approval granted';
      this.publish(sessionId, 'executor.error', { message });
      return type === 'permission' ? Promise.resolve({ kind: 'reject', feedback: message })
        : Promise.reject(new Error(message));
    }
    const requestId = randomUUID();
    return new Promise((resolveReview, rejectReview) => {
      const timer = setTimeout(() => {
        this.finishReview(requestId, undefined, 'Review expired; no approval granted');
      }, this.reviewTimeout);
      this.reviews.set(requestId, { requestId, sessionId, type, request, timer, resolveReview, rejectReview });
      this.publish(sessionId, 'executor.review', { requestId, type, request });
    });
  }

  finishReview(requestId, decision, reason) {
    const review = this.reviews.get(requestId);
    if (!review) throw new ExecutorError('Review no longer pending', 409);
    clearTimeout(review.timer);
    this.reviews.delete(requestId);
    this.publish(review.sessionId, 'executor.review.closed', { requestId, reason });
    if (review.type === 'permission') {
      review.resolveReview(decision === true
        ? { kind: 'approve-once', approvedInteractively: true }
        : { kind: 'reject', feedback: reason || 'User denied this request' });
    } else if (typeof decision === 'string') {
      review.resolveReview({
        answer: decision,
        wasFreeform: !review.request.choices?.includes(decision),
      });
    } else {
      review.rejectReview(new Error(reason || 'User input cancelled'));
    }
  }

  config(sessionId) {
    return {
      workingDirectory: this.workspace,
      streaming: true,
      onPermissionRequest: (request) => this.review(sessionId, 'permission', request),
      onUserInputRequest: (request) => this.review(sessionId, 'input', request),
      ...this.sessionConfig(sessionId),
    };
  }

  attach(id, session) {
    this.sessions.set(id, session);
    session.on((event) => this.publish(id, event.type, event.data));
  }

  list() {
    return Object.entries(this.catalog.sessions).map(([id, value]) => ({
      id, ...value, attached: this.sessions.has(id),
    }));
  }

  async snapshot(id) {
    identifier(id);
    const session = this.sessions.get(id);
    if (!session) throw new ExecutorError('Resume this executor-owned session first', 409);
    // Take the cursor first; live events arriving during history retrieval are replayed.
    const sequence = this.sequence;
    const history = [];
    let bytes = 0, truncated = false;
    const allEvents = await session.getEvents();
    for (const event of allEvents.toReversed()) {
      if (!['user.message', 'assistant.message'].includes(event.type)) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 900 * 1024) { truncated = true; break; }
      history.unshift(event);
      bytes += size;
    }
    return {
      epoch: this.epoch, sequence,
      history, truncated,
      reviews: [...this.reviews.values()].filter((r) => r.sessionId === id)
        .map(({ requestId, type, request }) => ({ requestId, type, request })),
    };
  }

  execute(command) {
    const next = this.queue.then(() => this.perform(command));
    this.queue = next.catch(() => {});
    return next;
  }

  async perform(command) {
    if (this.closing) throw new ExecutorError('Executor is stopping', 503);
    const { action, requestId, sessionId } = command;
    identifier(requestId);
    if (sessionId !== undefined) identifier(sessionId);
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const previous = this.catalog.operations[requestId];
    if (previous) {
      if (previous.hash !== hash) throw new ExecutorError('Request ID reused with different content', 409);
      return previous;
    }
    if (!['create', 'resume', 'send', 'abort', 'review'].includes(action)) {
      throw new ExecutorError('Unknown action');
    }
    if (action !== 'create' && !Object.hasOwn(this.catalog.sessions, sessionId)) {
      throw new ExecutorError('Session is not owned by this executor', 404);
    }
    if (action === 'send' && (typeof command.prompt !== 'string' || !command.prompt.trim()
      || command.prompt.length > 100_000)) throw new ExecutorError('Invalid prompt');
    const review = action === 'review' ? this.reviews.get(command.reviewId) : undefined;
    if (action === 'review') {
      if (!review || review.sessionId !== sessionId) throw new ExecutorError('Review no longer pending', 409);
      if (review.type === 'permission' && typeof command.decision !== 'boolean') {
        throw new ExecutorError('Permission decision must be true or false');
      }
      if (review.type === 'input' && (typeof command.decision !== 'string'
        || command.decision.length > 10_000
        || (review.request.allowFreeform === false && !review.request.choices?.includes(command.decision)))) {
        throw new ExecutorError('Invalid user input');
      }
    }
    if (['send', 'abort'].includes(action) && !this.sessions.has(sessionId)) {
      throw new ExecutorError('Resume this session first', 409);
    }
    const id = action === 'create' ? randomUUID() : sessionId;
    const operation = { hash, status: 'uncertain', sessionId: id };
    this.catalog.operations[requestId] = operation;
    // Persist BEFORE calling the runtime. A crash or lost response never authorizes replay.
    await this.persist();
    try {
      switch (action) {
        case 'create': {
          this.catalog.sessions[id] = { workspace: this.workspace };
          await this.persist();
          const session = await this.client.createSession({
            ...this.config(id), sessionId: id, name: `Remote ${id.slice(0, 8)}`,
          });
          this.attach(id, session);
          break;
        }
        case 'resume': {
          if (this.catalog.sessions[id].workspace !== this.workspace) {
            throw new ExecutorError('Start the executor with the original workspace', 409);
          }
          if (!this.sessions.has(id)) {
            const session = await this.client.resumeSession(id, {
              ...this.config(id), continuePendingWork: false, allowTranscriptRecovery: false,
            });
            this.attach(id, session);
          }
          break;
        }
        case 'send':
          operation.messageId = await this.sessions.get(id).send({ prompt: command.prompt });
          break;
        case 'abort':
          this.cancelReviews(id, 'Turn aborted by user');
          await Promise.all([this.sessions.get(id).abort(), this.onAbort(id)]);
          break;
        case 'review':
          this.finishReview(command.reviewId, command.decision);
          break;
      }
      operation.status = 'accepted';
    } catch (error) {
      // Even runtime errors can occur after work was accepted. Do not retry them.
      operation.error = error.message;
      this.publish(id, 'executor.error', { requestId, message: error.message });
    }
    await this.persist();
    return operation;
  }

  cancelReviews(sessionId, reason) {
    for (const review of [...this.reviews.values()]) {
      if (!sessionId || review.sessionId === sessionId) {
        this.finishReview(review.requestId, undefined, reason);
      }
    }
  }

  async close() {
    this.closing = true;
    this.cancelReviews(undefined, 'Executor stopped; no approval granted');
    const errors = await this.client.stop();
    await this.queue;
    if (errors.length) throw new AggregateError(errors, 'Copilot runtime cleanup failed');
  }
}
