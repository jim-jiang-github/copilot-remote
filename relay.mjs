import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHistoryReader, checkSessionBusy } from './history.mjs';
import { createController, AppError } from './server.mjs';
import { localAccount } from './account.mjs';
import { appendAudit, markStopped, applyAdmission, payloadReference, matchesForwardIntent, exactDispatchArgs, terminalStates } from './relay-state.mjs';

const local = new URL('./.local/', import.meta.url);
const ledgerUrl = new URL('relay-ledger.json', local);
const configUrl = new URL('relay-probe-config.json', local);
const normalize = name => name.replace(/^functions\./, '');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isExactForward(input, active) {
  const args = input.toolArgs;
  return normalize(input.toolName) === 'send_session_message' && active?.type === 'send' &&
    args?.session_id === active.id && args.message === active.text &&
    (!args.delivery_mode || args.delivery_mode === 'immediate') &&
    Object.keys(args).every(key => ['session_id', 'message', 'delivery_mode'].includes(key));
}

export function isAppAdmission(result) {
  const text = result?.textResultForLlm ?? result?.sessionLog;
  return result?.resultType === 'success' && typeof text === 'string' && text.startsWith('Message accepted for ');
}

export function creationArgs(operation) {
  const args = { name: operation.name, coordinate_with_creator: false, detached: true };
  if (operation.projectId) return { ...args, project_id: operation.projectId, session_kind: 'project' };
  return { ...args, session_kind: 'chat' };
}

export function isExactCreate(input, active) {
  if (normalize(input.toolName) !== 'create_session' || active?.type !== 'create') return false;
  const expected = creationArgs(active);
  return input.toolArgs && Object.keys(input.toolArgs).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => input.toolArgs[key] === value);
}

export function canExecuteDirect(session) {
  return typeof session?.rpc?.tools?.execute === 'function' ||
         typeof session?.connection?.sendRequest === 'function';
}

export function normalizeToolResult(result) {
  if (typeof result === 'string') {
    return {
      resultType: 'success',
      textResultForLlm: result,
      sessionLog: result
    };
  }
  return result ?? { resultType: 'failure', textResultForLlm: '', error: 'Tool returned empty result' };
}

export async function executeToolDirectly(session, name, args = {}) {
  if (typeof session?.rpc?.tools?.execute === 'function') {
    return await session.rpc.tools.execute({ name, arguments: args });
  }
  if (typeof session?.connection?.sendRequest === 'function') {
    return await session.connection.sendRequest('session.tools.execute', {
      sessionId: session.sessionId,
      name,
      arguments: args
    });
  }
  throw new Error('Direct RPC tool execution not supported by session.');
}

export function parseAppTargets(text) {
  if (typeof text !== 'string') throw new Error('App enumeration did not contain text.');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('App enumeration did not contain a recognized JSON list.');
  const items = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(items) || items.length > 200) throw new Error('Invalid App target list.');
  const seen = new Set();
  return items.map(item => {
    const title = item.name ?? item.title;
    if (!/^[0-9a-f-]{36}$/.test(item.id) || !['session', 'chat'].includes(item.type) ||
        typeof title !== 'string' || !title || title.length > 300 || seen.has(item.id)) throw new Error('Invalid or duplicate App target.');
    seen.add(item.id);
    return { id: item.id, title, kind: item.type === 'chat' ? 'chat' : 'project',
      path: typeof item.path === 'string' ? item.path : null,
      projectId: item.project_id ?? null, projectName: item.project_name ?? null,
      parentId: item.parent_session_id ?? item.coordinating_creator_session_id ?? item.creator_session_id ?? null,
      description: item.project_name ?? 'App 聊天' };
  });
}

export async function startRelay(joinSession, options = {}) {
  const configPath = options.configUrl ?? configUrl;
  const configFile = configPath instanceof URL ? fileURLToPath(configPath) : configPath;
  const runtimeId = options.runtimeId ?? process.env.SESSION_ID;
  let config = options.config;
  if (!config) {
    try { config = JSON.parse(await readFile(configFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const bindSession = await joinSession({
        tools: [{
          name: 'remote_relay_bind',
          description: 'One-time setup: bind this current Copilot App session as the relay coordinator. Use only the exact session ID obtained from list_sessions_and_chats for this current chat.',
          parameters: {
            type: 'object',
            properties: { appId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } },
            required: ['appId'],
            additionalProperties: false
          },
          handler: async ({ appId }) => {
            if (!uuid.test(runtimeId ?? '') || !uuid.test(appId ?? '')) {
              throw new Error('Binding requires valid Copilot runtime and App session IDs.');
            }
            const boundConfig = { appId, runtimeId };
            await mkdir(path.dirname(configFile), { recursive: true });
            try {
              await writeFile(configFile, JSON.stringify(boundConfig, null, 2), { flag: 'wx', mode: 0o600 });
            } catch (writeError) {
              if (writeError.code === 'EEXIST') throw new Error('Relay is already bound. Do not overwrite its session binding.');
              throw writeError;
            }
            return 'This Copilot App session is bound. Run extensions_reload in this session; the relay will start automatically when the extension reloads.';
          }
        }]
      });
      return bindSession;
    }
  }
  if (runtimeId !== config.runtimeId) return joinSession({ tools: [] });
  const account = options.account ?? localAccount(new URL('account.json', local));
  let verificationCredentials = null;
  const serviceAccount = config.verificationEnabled ? {
    status: () => account.status(),
    setup: (...args) => account.setup(...args),
    authenticate: (username, password) => verificationCredentials &&
      username === verificationCredentials.username && password === verificationCredentials.password
      ? Promise.resolve(true) : account.authenticate(username, password)
  } : account;
  const storage = options.ledgerUrl ?? ledgerUrl;
  let ledger;
  try { ledger = JSON.parse(await readFile(storage, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { requests: {} }; }
  for (const record of Object.values(ledger.requests)) {
    if (['submitting', 'coordinator_queued', 'invoking', 'created_pending_lookup'].includes(record.status)) record.status = 'unknown';
  }
  let targets = [];
  const readHistory = createHistoryReader({ root: path.join(homedir(), '.copilot', 'session-state'), targets: () => targets });
  let targetsAt = 0;
  let listError = null;
  let active = null;
  let server;
  let session;
  let runOwner = null;
  const contexts = new Map();
  const calls = new Map();
  const messages = new Map();
  const hookOwners = new Map();
  let stopTimer;
  let persistChain = Promise.resolve();
  const persist = () => {
    const data = JSON.stringify(ledger, null, 2);
    persistChain = persistChain.then(() => writeFile(storage, data, { mode: 0o600 }));
    return persistChain;
  };
  await persist();
  const exact = input => matchesForwardIntent(input, active) &&
    (input.toolArgs?.message === payloadReference(active.requestId) || input.toolArgs?.message === active?.text);
  function recordFor(context) { return context ? ledger.requests[context.requestId] : null; }
  function hookKey(input) {
    return `${normalize(input.toolName)}:${input.toolArgs?.session_id ?? input.toolArgs?.project_session_id ?? ''}`;
  }
  function allow(input, context, modifiedArgs) {
    const key = hookKey(input);
    const queue = hookOwners.get(key) ?? [];
    queue.push(context);
    hookOwners.set(key, queue);
    return { permissionDecision: 'allow', ...(modifiedArgs ? { modifiedArgs } : {}) };
  }
  function resultContext(input) {
    return hookOwners.get(hookKey(input))?.shift();
  }
  function release(context) { if (active === context) active = null; }
  async function receiveResult(input, context, source) {
    if (!context) return;
    const record = recordFor(context);
    if (record && ['app_accepted', 'app_created'].includes(record.status)) return;
    const name = normalize(input.toolName);
    const success = input.toolResult?.resultType === 'success';
    if (record) appendAudit(record, 'tool_result', { name, success, source });
    if (context.type === 'targets' && name === 'list_sessions_and_chats') {
      if (!success) {
        targets = [];
        listError = 'App 会话枚举失败，请检查协调会话。';
      } else {
        try {
          targets = parseAppTargets(input.toolResult.textResultForLlm ?? input.toolResult.sessionLog).map(item => ({
            ...item, relayCoordinator: item.id === config.appId
          }));
          targetsAt = Date.now();
          listError = null;
        } catch {
          targets = [];
          listError = 'App 会话列表格式无法解析；未使用模型猜测或旧列表。';
        }
      }
      release(context);
    } else if (context.type === 'send' && name === 'get_session' && input.toolArgs?.project_session_id === context.id) {
      const text = input.toolResult?.textResultForLlm ?? input.toolResult?.sessionLog ?? '';
      let metadata;
      try { metadata = JSON.parse(text); } catch { metadata = null; }
      context.validated = success && metadata?.id === context.id && !metadata.archived_at && !metadata.archived;
      if (context.validated) appendAudit(record, 'target_verified', { id: context.id });
      else if (!text.startsWith('[copilot:elided')) {
        record.status = 'failed';
        record.error = '目标查询未确认现有未归档 App 会话；尚未执行投递。';
        release(context);
      }
    } else if (context.type === 'send' && matchesForwardIntent(input, context) && context.invoked) {
      applyAdmission(record, input.toolResult);
      release(context);
    } else if (context.type === 'create' && name === 'create_session') {
      const text = input.toolResult?.textResultForLlm ?? input.toolResult?.sessionLog ?? '';
      const match = typeof text === 'string' ? text.match(/(?:session_id:\s*|"id"\s*:\s*")([0-9a-f-]{36})/) : null;
      record.appReceipt = text;
      if (success && match) {
        context.createdId = match[1];
        record.createdId = match[1];
        record.status = 'created_pending_lookup';
      } else {
        record.status = 'unknown';
        record.error = 'App 创建工具未返回可验证的 ID；不要重建。';
        release(context);
      }
    } else if (context.type === 'create' && name === 'get_session' && input.toolArgs?.project_session_id === context.createdId) {
      const text = input.toolResult?.textResultForLlm ?? input.toolResult?.sessionLog ?? '';
      let metadata;
      try { metadata = JSON.parse(text); } catch { metadata = null; }
      record.status = success && metadata?.id === context.createdId ? 'app_created' : 'unknown';
      if (record.status === 'app_created') {
        const project = targets.find(item => item.projectId === record.projectId);
        if (!targets.some(item => item.id === context.createdId)) targets.push({
          id: context.createdId, title: metadata.name ?? record.name, kind: record.projectId ? 'project' : 'chat',
          projectId: record.projectId, projectName: project?.projectName ?? null, parentId: metadata.parent_session_id ?? null,
          description: project?.projectName ?? 'App 聊天'
        });
      } else record.error = '创建后的查询未确认会话，请检查 App。';
      release(context);
    }
    await persist();
  }
  function settleStopped(context, aborted, reason) {
    if (!context) return;
    if (context.type === 'targets') {
      if (active === context) listError = aborted ? '会话枚举中转已取消，请重新刷新。' : '协调助手结束但没有列表结果。';
    } else markStopped(recordFor(context), { requestId: context.requestId, aborted, reason });
    release(context);
    persist().catch(error => console.error(`Relay receipt persistence failed: ${error.message}`));
  }
  function fail(code, message) { throw new AppError(409, code, message); }
  async function submit(operation) {
    if (!server) fail('RELAY_OFFLINE', 'Coordinator service is not enabled.');
    if (operation.action === 'history') return readHistory(operation);
    if (operation.action === 'snapshot') {
      if (targets.length === 0 && targetsAt === 0 && !active && canExecuteDirect(session)) {
        try {
          const listRaw = await executeToolDirectly(session, 'list_sessions_and_chats', {});
          const listResult = normalizeToolResult(listRaw);
          if (listResult.resultType === 'success') {
            const rawText = listResult.textResultForLlm ?? listResult.sessionLog ?? '';
            targets = parseAppTargets(rawText).map(item => ({
              ...item, relayCoordinator: item.id === config.appId
            }));
            targetsAt = Date.now();
            listError = null;
          }
        } catch (rpcError) {
          console.warn('Initial direct RPC list_sessions_and_chats failed:', rpcError?.message ?? rpcError);
        }
      }
      const sessionRoot = path.join(homedir(), '.copilot', 'session-state');
      const sessions = targets.map(item => ({
        ...item,
        busy: checkSessionBusy(sessionRoot, item.id)
      }));
      return { connected: true, sessions, selected: null, transcript: [], desktopDraft: false,
        deliveries: Object.values(ledger.requests).filter(record => record.text).slice(-100).map(({ requestId, id, text, status, error, createdAt, acceptedAt }) => ({ requestId, id, text, status, error, createdAt, acceptedAt })),
        relay: true, targetsAt, listError, refreshing: active?.type === 'targets', activeRequestId: active?.requestId ?? null,
        receipts: Object.values(ledger.requests).map(({ requestId, id, status, error, appReceipt, createdId, type }) => ({ requestId, id, status, error, appReceipt, createdId, type })) };
    }
    if (operation.action === 'select') {
      const target = targets.find(item => item.id === operation.id);
      if (!target) fail('TARGET_UNAVAILABLE', 'Refresh the existing App targets first.');
      return { selected: { id: target.id, title: target.title }, relay: true };
    }
    if (operation.action === 'send') {
      const previous = ledger.requests[operation.requestId];
      if (previous) {
        if (previous.id !== operation.id || previous.text !== operation.text) fail('REQUEST_CONFLICT', 'Request ID already belongs to another message.');
        return { submitted: true, requestId: previous.requestId, status: previous.status, relay: true };
      }
    }
    if (operation.action === 'create' && ledger.requests[operation.requestId]) {
      const previous = ledger.requests[operation.requestId];
      if (previous.name !== operation.name || previous.projectId !== operation.projectId || previous.type !== 'create') fail('REQUEST_CONFLICT', 'Request ID already used.');
      return { submitted: true, requestId: previous.requestId, status: previous.status, relay: true };
    }
    if (active) fail('RELAY_BUSY', 'Coordinator is processing another request. Wait for its result.');
    clearTimeout(stopTimer);
    runOwner = null;
    if (operation.action === 'targets') {
      active = { type: 'targets', requestId: randomUUID() };
      contexts.set(active.requestId, active);
      listError = null;

      if (canExecuteDirect(session)) {
        try {
          const listRaw = await executeToolDirectly(session, 'list_sessions_and_chats', {});
          const listResult = normalizeToolResult(listRaw);
          if (listResult.resultType === 'success') {
            const rawText = listResult.textResultForLlm ?? listResult.sessionLog ?? '';
            targets = parseAppTargets(rawText).map(item => ({
              ...item, relayCoordinator: item.id === config.appId
            }));
            targetsAt = Date.now();
            listError = null;
            active = null;
            return { refreshing: false, sessions: targets, relay: true };
          }
        } catch (rpcError) {
          console.warn('Direct RPC list_sessions_and_chats failed, falling back to coordinator prompt:', rpcError?.message ?? rpcError);
        }
      }

      const context = active;
      const messageId = await session.send({ prompt: `[REMOTE_REQUEST ${context.requestId}] Call list_sessions_and_chats exactly once. The extension parses the real result. No other action. End.` });
      context.coordinatorMessageId = messageId;
      messages.set(messageId, context);
      return { refreshing: true, relay: true };
    }
    if (operation.action === 'create') {
      if (operation.projectId && (!targets.some(item => item.projectId === operation.projectId) || Date.now() - targetsAt > 300000)) fail('PROJECT_UNAVAILABLE', '请先刷新真实 App 项目列表。');
      if (Object.keys(ledger.requests).length >= 1000) fail('RECEIPT_LIMIT', 'Receipt capacity reached.');
      const record = { ...operation, type: 'create', status: 'submitting', createdAt: new Date().toISOString() };
      ledger.requests[record.requestId] = record;
      active = { ...record, invoked: false };
      contexts.set(record.requestId, active);
      await persist();

      if (canExecuteDirect(session)) {
        try {
          const createRaw = await executeToolDirectly(session, 'create_session', creationArgs(operation));
          const createResult = normalizeToolResult(createRaw);
          const text = createResult.textResultForLlm ?? createResult.sessionLog ?? '';
          const match = typeof text === 'string' ? text.match(/(?:session_id:\s*|"id"\s*:\s*")([0-9a-f-]{36})/) : null;
          record.appReceipt = text;
          if (createResult.resultType === 'success' && match) {
            record.createdId = match[1];
            const lookupRaw = await executeToolDirectly(session, 'get_session', { project_session_id: record.createdId });
            const lookupResult = normalizeToolResult(lookupRaw);
            const lookupText = lookupResult.textResultForLlm ?? lookupResult.sessionLog ?? '';
            let metadata;
            try { metadata = JSON.parse(lookupText); } catch { metadata = null; }
            record.status = lookupResult.resultType === 'success' && metadata?.id === record.createdId ? 'app_created' : 'unknown';
            if (record.status === 'app_created') {
              const project = targets.find(item => item.projectId === record.projectId);
              if (!targets.some(item => item.id === record.createdId)) targets.push({
                id: record.createdId, title: metadata?.name ?? record.name, kind: record.projectId ? 'project' : 'chat',
                projectId: record.projectId, projectName: project?.projectName ?? null, parentId: metadata?.parent_session_id ?? null,
                description: project?.projectName ?? 'App 聊天'
              });
            } else {
              record.error = '创建后的查询未确认会话，请检查 App。';
            }
          } else {
            record.status = 'unknown';
            record.error = 'App 创建工具未返回可验证的 ID；不要重建。';
          }
          active = null;
          await persist();
          return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
        } catch (rpcError) {
          console.warn('Direct RPC create_session failed, falling back to coordinator prompt:', rpcError?.message ?? rpcError);
        }
      }

      try {
        const context = active;
        record.coordinatorMessageId = await session.send({ prompt: `[REMOTE_REQUEST ${record.requestId}] Call create_session once with only ${JSON.stringify(creationArgs(operation))}. No kickoff or navigation. Then get_session for the returned ID. Never retry. End.` });
        context.coordinatorMessageId = record.coordinatorMessageId;
        messages.set(record.coordinatorMessageId, context);
        if (record.status === 'submitting') record.status = 'coordinator_queued';
        await persist();
        return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
      } catch {
        record.status = 'unknown';
        record.error = '创建请求结果未知，请检查 App；不会自动重建。';
        await persist();
        fail('DELIVERY_UNKNOWN', record.error);
      }
    }
    if (operation.action !== 'send') fail('INVALID_OPERATION', 'Unsupported operation.');
    const target = targets.find(item => item.id === operation.id);
    if (!target || Date.now() - targetsAt > 300000) fail('TARGET_UNAVAILABLE', 'Target list expired or target is unavailable. Refresh first.');
    if (Object.keys(ledger.requests).length >= 1000) fail('RECEIPT_LIMIT', 'Receipt limit reached. Inspect the stored ledger before maintenance.');
    let sendText = operation.text;
    if (Array.isArray(operation.attachments) && operation.attachments.length) {
      const attachLines = operation.attachments.map((a, i) => `${i + 1}. ${a.path} (${a.name})`).join('\n');
      sendText = `[用户上传了 ${operation.attachments.length} 张图片附件]:\n${attachLines}` + (operation.text?.trim() ? `\n\n${operation.text.trim()}` : '');
    }
    const record = { requestId: operation.requestId, id: operation.id, text: sendText, status: 'submitting', createdAt: new Date().toISOString() };
    ledger.requests[operation.requestId] = record;
    active = { ...record, type: 'send', invoked: false, validated: false };
    contexts.set(record.requestId, active);
    appendAudit(record, 'submitted');
    await persist();

    if (operation.id === config.appId) {
      try {
        appendAudit(record, 'current_session_send_started', { id: record.id });
        record.coordinatorMessageId = await session.send({ prompt: sendText });
        record.status = 'app_accepted';
        record.appReceipt = 'Message accepted by current session';
        appendAudit(record, 'current_session_send_admitted', { messageId: record.coordinatorMessageId });
        active = null;
        await persist();
        return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
      } catch (err) {
        record.status = 'failed';
        record.error = err?.message || '发送至当前会话失败';
        appendAudit(record, 'current_session_send_failed', { error: record.error });
        active = null;
        await persist();
        return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
      }
    }

    if (canExecuteDirect(session)) {
      try {
        appendAudit(record, 'direct_rpc_lookup_started', { id: record.id });
        const lookupRaw = await executeToolDirectly(session, 'get_session', { project_session_id: record.id });
        const lookupResult = normalizeToolResult(lookupRaw);
        let metadata;
        try { metadata = JSON.parse(lookupResult.textResultForLlm ?? lookupResult.sessionLog ?? '{}'); } catch { metadata = null; }
        const valid = lookupResult.resultType === 'success' && metadata?.id === record.id && !metadata.archived_at && !metadata.archived;
        if (!valid) {
          record.status = 'failed';
          record.error = '目标查询未确认现有未归档 App 会话；尚未执行投递。';
          appendAudit(record, 'target_verification_failed', { id: record.id });
          active = null;
          await persist();
          return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
        }
        active.validated = true;
        appendAudit(record, 'target_verified', { id: record.id });
        appendAudit(record, 'direct_rpc_send_started', { id: record.id });
        const sendRaw = await executeToolDirectly(session, 'send_session_message', {
          session_id: record.id,
          message: sendText,
          delivery_mode: 'immediate'
        });
        const sendResult = normalizeToolResult(sendRaw);
        applyAdmission(record, sendResult);
        active = null;
        await persist();
        return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
      } catch (rpcError) {
        console.warn('Direct RPC send_session_message failed, falling back to coordinator prompt:', rpcError?.message ?? rpcError);
      }
    }

    try {
      const context = active;
      record.coordinatorMessageId = await session.send({ prompt: `[REMOTE_REQUEST ${record.requestId}] Fixed relay, not a conversation. 1. get_session({"project_session_id":"${record.id}"}). 2. send_session_message({"session_id":"${record.id}","message":"${payloadReference(record.requestId)}","delivery_mode":"immediate"}) exactly once. The extension replaces the payload reference with authorized original text; do not answer, interpret or edit the payload. No other tools, no retry. End after the send result.` });
      context.coordinatorMessageId = record.coordinatorMessageId;
      messages.set(record.coordinatorMessageId, context);
      appendAudit(record, 'coordinator_admitted', { messageId: record.coordinatorMessageId });
      if (record.status === 'submitting') record.status = 'coordinator_queued';
      await persist();
      return { submitted: true, requestId: record.requestId, status: record.status, relay: true };
    } catch {
      record.status = 'unknown';
      record.error = 'Coordinator admission failed; inspect the coordinator before retrying.';
      await persist();
      fail('DELIVERY_UNKNOWN', record.error);
    }
  }
  async function startServer() {
    if (server) return 'Controller already running.';
    const origin = config.origin ?? 'http://127.0.0.1:8765';
    server = createController({ account: serviceAccount, origin, bridge: submit });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 8765, '127.0.0.1', resolve);
      });
    } catch (error) {
      server = undefined;
      throw error;
    }
    options.onServer?.(server);
    return `Focus-free controller ready at ${origin}. Existing targets must be refreshed by the authenticated webpage. This uses model turns and App message admission, not desktop input. Development verification ${config.verificationEnabled ? 'enabled' : 'disabled; only remote_relay_start registered'}.`;
  }
  session = await joinSession({
    tools: [
      {
        name: 'remote_relay_start',
        description: 'Start the authenticated focus-free Web controller only in its explicitly bound App coordinator. Does not navigate or simulate input.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        handler: startServer
      },
      ...(config.verificationEnabled ? [{
        name: 'remote_relay_verify',
        description: 'Authorized development verification ONLY: queue unique question payloads to the dedicated disposable test chat or refresh targets; read ledger status. Never targets working chats or repeats the reported user request.',
        parameters: { type: 'object', properties: { action: { enum: ['targets', 'question', 'status', 'visual'] }, requestId: { type: 'string' } }, required: ['action'], additionalProperties: false },
        handler: async args => {
          if (!server) throw new Error('Start controller before verification.');
          if (verificationCredentials) throw new Error('Verification already running.');
          const origin = config.origin ?? 'http://127.0.0.1:8765';
          verificationCredentials = { username: `verify-${randomUUID()}`, password: randomUUID() };
          let cookie;
          const call = (route, body) => new Promise((resolve, reject) => {
            const request = httpRequest(`http://127.0.0.1:${server.address().port}/api/${route}`, {
              method: body === undefined ? 'GET' : 'POST',
              headers: { Host: new URL(origin).host, Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            }, response => {
              const chunks = [];
              response.on('data', chunk => chunks.push(chunk));
              response.on('end', () => {
                try {
                  if (route === 'login') cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
                  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  if (response.statusCode !== 200) throw new Error(`Verification HTTP ${response.statusCode}: ${result.code ?? 'request failed'}`);
                  resolve(result);
                } catch (error) { reject(error); }
              });
              response.on('error', reject);
            });
            request.on('error', reject);
            request.setTimeout(25000, () => request.destroy(new Error('Verification HTTP timeout; do not retry.')));
            request.end(body === undefined ? undefined : JSON.stringify(body));
          });
          try {
            await call('login', verificationCredentials);
            if (args.action === 'visual') {
              const { checkLiveBrowser } = await import('./test/live-browser-check.mjs');
              return JSON.stringify(await checkLiveBrowser({ origin, ...verificationCredentials,
                targetId: config.historyVerificationTargetId ?? config.targetId, history: Boolean(config.historyVerificationTargetId) }));
            }
            if (args.action === 'status') return JSON.stringify(await call('snapshot'));
            if (args.action === 'targets') return JSON.stringify(await call('targets', {}));
            if (!/^[0-9a-f-]{36}$/.test(args.requestId ?? '')) throw new Error('Unique verification request ID required.');
            const selected = await call('select', { id: config.targetId });
            const request = { id: config.targetId, requestId: args.requestId,
              text: `我可以创建什么项目吗？\n[RELAY_VERIFY_${args.requestId}] 本条只在专用测试聊天验证普通问句原文转发，请只回复收到，不使用工具。` };
            const first = await call('send', request);
            const duplicate = await call('send', request);
            return JSON.stringify({ ...first, authenticatedHttp: true, selectedId: selected.selected.id,
              duplicateMatched: duplicate.requestId === first.requestId });
          } finally {
            verificationCredentials = null;
            if (cookie) await call('logout', {});
          }
        }
      }] : [])
    ],
    hooks: {
      onPreToolUse: async input => {
        const name = normalize(input.toolName);
        if (!active) {
          if ((runOwner && name !== 'task_complete') || ['send_session_message', 'create_session'].includes(name)) return {
            permissionDecision: 'deny', permissionDecisionReason: 'Web relay request is finished. No follow-up tools, commands, forwarding or creation are authorized.'
          };
          return;
        }
        const context = active;
        const record = recordFor(context);
        if (record && terminalStates.has(record.status)) return { permissionDecision: 'deny', permissionDecisionReason: 'Request already terminal. No retry permitted.' };
        if (runOwner && runOwner !== context) return { permissionDecision: 'deny', permissionDecisionReason: 'This tool belongs to another coordinator turn, not the queued Web request.' };
        if (record) appendAudit(record, 'tool_attempt', { name });
        if (active.type === 'targets' && name === 'list_sessions_and_chats' && Object.keys(input.toolArgs ?? {}).length === 0) {
          active.started = true;
          return allow(input, context);
        }
        if (active.type === 'send' && !active.invoked && name === 'get_session' &&
            input.toolArgs?.project_session_id === active.id && Object.keys(input.toolArgs).length === 1) {
          active.started = true;
          return allow(input, context);
        }
        if (isExactCreate(input, active) && !active.invoked) {
          active.started = true;
          active.invoked = true;
          ledger.requests[active.requestId].status = 'invoking';
          record.dispatchAuthorized = true;
          await persist();
          return allow(input, context);
        }
        if (active.type === 'create' && active.createdId && name === 'get_session' &&
            input.toolArgs?.project_session_id === active.createdId && Object.keys(input.toolArgs).length === 1) return allow(input, context);
        if ((exact(input) || isExactForward(input, active)) && !active.invoked && active.validated) {
          active.invoked = true;
          record.status = 'invoking';
          record.dispatchAuthorized = true;
          appendAudit(record, 'dispatch_authorized', { id: context.id });
          await persist();
          return allow(input, context, exactDispatchArgs(context));
        }
        if (record) {
          appendAudit(record, 'tool_denied', { name, validated: Boolean(context.validated), invoked: Boolean(context.invoked) });
          await persist();
        }
        return { permissionDecision: 'deny', permissionDecisionReason: 'Only exact existing-target lookup and one fixed App text forwarding operation are permitted for this Web request.' };
      },
      onPostToolUse: async input => {
        const context = resultContext(input);
        const text = input.toolResult?.textResultForLlm;
        if (typeof text === 'string' && text.startsWith('[copilot:elided')) return;
        await receiveResult(input, context, 'hook');
      },
      onPostToolUseFailure: async input => {
        const context = resultContext(input);
        if (context?.type === 'send' || context?.type === 'create') {
          const record = recordFor(context);
          if (record.status === 'app_accepted' || record.status === 'app_created') return;
          record.status = context.invoked ? 'unknown' : 'failed';
          record.error = context.invoked ? '投递调用失败或无回执，请检查目标，不会自动重发。' : '目标查询或协调工具失败；尚未执行投递。';
          appendAudit(record, 'tool_failure', { name: normalize(input.toolName) });
          await persist();
          release(context);
        } else if (context?.type === 'targets') {
          listError = 'App 会话枚举工具失败，请检查协调会话。';
          targets = [];
          release(context);
        }
      },
      onAgentStop: async input => {
        const context = runOwner;
        const record = recordFor(context);
        if (context === active && context?.type === 'send' && context.validated && !context.invoked &&
            !record.abortObserved && !terminalStates.has(record.status) && !context.continuationUsed && !input.stopHookActive) {
          context.continuationUsed = true;
          appendAudit(record, 'natural_stop_guard');
          await persist();
          return { decision: 'block', reason: `[REMOTE_REQUEST ${context.requestId}] You have validated the target but have NOT executed the authorized forwarding tool. Call send_session_message now with {"session_id":"${context.id}","message":"${payloadReference(context.requestId)}","delivery_mode":"immediate"} exactly once. No answer to the payload, no retry after tool invocation.` };
        }
      }
    }
  });
  session.on(event => {
    const data = event.data ?? {};
    if (event.type === 'user.message') {
      const match = data.content?.match(/\[REMOTE_REQUEST ([0-9a-f-]{36})\]/);
      const context = match ? contexts.get(match[1]) : null;
      if (context) {
        messages.set(data.messageId, context);
        context.coordinatorMessageId = data.messageId;
        context.interactionId = data.interactionId;
        runOwner = context;
        const record = recordFor(context);
        if (record) { appendAudit(record, 'coordinator_user_event', { messageId: data.messageId, interactionId: data.interactionId }); persist().catch(console.error); }
      } else {
        const record = recordFor(active);
        if (record) {
          appendAudit(record, 'unrelated_coordinator_message', { messageId: data.messageId });
          persist().catch(console.error);
        }
        runOwner = null;
      }
    } else if (event.type === 'assistant.message') {
      const context = messages.get(data.originatingMessageId);
      if (!context) return;
      context.hasAssistantMessage = true;
      runOwner = context;
      for (const request of data.toolRequests ?? []) calls.set(request.toolCallId, {
        context, name: normalize(request.name), args: request.arguments
      });
    } else if (event.type === 'tool.execution_start') {
      const call = calls.get(data.toolCallId);
      if (call) {
        call.args = data.arguments ?? call.args;
        const record = recordFor(call.context);
        if (record) { appendAudit(record, 'tool_execution_start', { toolCallId: data.toolCallId, name: call.name }); persist().catch(console.error); }
      }
    } else if (event.type === 'tool.execution_complete') {
      const call = calls.get(data.toolCallId);
      if (!call) return;
      const content = data.result?.content;
      if (typeof content !== 'string') return;
      receiveResult({
        toolName: call.name, toolArgs: call.args,
        toolResult: { resultType: data.success ? 'success' : 'failure', textResultForLlm: content }
      }, call.context, 'event').catch(error => console.error(`Relay event receipt persistence failed: ${error.message}`));
    } else if (event.type === 'abort') {
      const context = runOwner;
      const record = recordFor(context);
      if (record) {
        record.abortObserved = true;
        appendAudit(record, 'abort', { runtimeReason: data.reason ?? 'unspecified', originKnown: false });
      }
      if (context) settleStopped(context, true, data.reason ?? 'runtime_abort');
      else if (active) {
        const interrupted = active;
        if (interrupted.type === 'targets') listError = '协调运行时停止，列表刷新未确认；可重新刷新。';
        const record = recordFor(interrupted);
        if (record && !terminalStates.has(record.status)) {
          record.status = 'unknown';
          record.error = '协调运行时停止，但停止事件无法精确关联此请求；结果未知，不会自动重发。';
          appendAudit(record, 'uncorrelated_abort', { runtimeReason: data.reason ?? 'unspecified' });
        }
        release(interrupted);
        persist().catch(console.error);
      }
    } else if (event.type === 'session.idle') {
      const context = runOwner;
      if (!context || (!context.started && !context.hasAssistantMessage) ||
          (data.interactionId && context.interactionId && data.interactionId !== context.interactionId)) return;
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => settleStopped(context, Boolean(recordFor(context)?.abortObserved), 'correlated_idle'), 200);
    }
  });
  const watchdog = setInterval(() => {
    if (!['send', 'create'].includes(active?.type)) return;
    const record = ledger.requests[active.requestId];
    if (Date.now() - Date.parse(record.createdAt) > 180000 && !['app_accepted', 'app_created', 'failed', 'unknown'].includes(record.status)) {
      record.status = 'unknown';
      record.error = 'Coordinator timed out; request may still be queued. Do not resend.';
      release(active);
      persist().catch(error => console.error(`Relay receipt persistence failed: ${error.message}`));
    }
  }, 5000);
  watchdog.unref();
  const close = async () => { clearTimeout(stopTimer); clearInterval(watchdog); server?.close(); await persistChain; };
  process.once('SIGTERM', close);
  options.onClose?.(close);
  if (options.autoStart ?? !options.config) await startServer();
  return session;
}
