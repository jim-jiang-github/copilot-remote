import { open, lstat, readdir } from 'node:fs/promises';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './server.mjs';

const uuid = /^[0-9a-f-]{36}$/;
const digest = data => createHash('sha256').update(data).digest('hex');
const invalid = message => new AppError(409, 'HISTORY_INVALID', message);
const unavailable = message => new AppError(404, 'HISTORY_UNAVAILABLE', message);
const changed = () => new AppError(409, 'HISTORY_CHANGED', '历史文件已截断或替换，请重新加载历史。');

async function safePath(file) {
  const resolved = path.resolve(file);
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw unavailable('历史路径包含链接或重解析目录，已拒绝读取。');
  }
}
async function readAt(file, offset, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, offset + total);
    if (!bytesRead) throw changed();
    total += bytesRead;
  }
  return buffer;
}
function visibleMessage(event) {
  if (!['user.message', 'assistant.message'].includes(event.type)) return null;
  const data = event.data;
  if (!data || typeof data.content !== 'string' || typeof data.messageId !== 'string') throw invalid('未知的消息结构；未猜测或忽略消息。');
  if (event.type === 'assistant.message' && data.phase !== undefined && !['commentary', 'final_answer'].includes(data.phase)) throw invalid('未知的助手消息 phase。');
  if (data.attachments !== undefined && !Array.isArray(data.attachments)) throw invalid('未知附件结构。');
  const attachments = (data.attachments ?? []).map(item => {
    if (!item || typeof item !== 'object') throw invalid('未知附件结构。');
    // Deliberately exclude arbitrary paths, URLs, blobs and document contents.
    const name = item.displayName ?? item.display_name ?? item.name;
    if (typeof name !== 'string') throw invalid('附件缺少可识别的安全名称。');
    const safeName = path.basename(name.replace(/\\/g, '/')).slice(0, 200);
    let rawFilename = safeName;
    if (typeof item.path === 'string') {
      const match = item.path.match(/[\\/]\.copilot[\\/](?:workspaces[\\/][^\\/]+[\\/])?attachments[\\/]([0-9a-zA-Z._-]+)$/i);
      if (match) rawFilename = match[1];
    }
    return { name: safeName, filename: rawFilename };
  });

  // Also extract any user uploaded image attachments embedded in the prompt format
  let displayContent = data.content;
  if (event.type === 'user.message' && typeof data.content === 'string') {
    const embedRegex = /\[用户上传了 \d+ 张图片附件\]:\s*([\s\S]*?)(?:\n\n|$)/;
    const match = data.content.match(embedRegex);
    if (match) {
      const fileLines = match[1].split('\n');
      for (const line of fileLines) {
        const fileMatch = line.match(/\d+\.\s+([^\s]+)\s+\(([^)]+)\)/);
        if (fileMatch) {
          const filePath = fileMatch[1];
          const displayName = fileMatch[2];
          const fileName = path.basename(filePath.replace(/\\/g, '/'));
          if (!attachments.some(a => a.filename === fileName)) {
            attachments.push({ name: displayName, filename: fileName });
          }
        }
      }
      displayContent = data.content.replace(embedRegex, '').trim();
    }
  }

  if (!displayContent.trim() && !attachments.length) return null;
  return {
    id: event.id, messageId: data.messageId, role: event.type === 'user.message' ? 'user' : 'assistant',
    content: displayContent, timestamp: event.timestamp,
    source: data.isAutopilotContinuation ? '自动续行' : data.source ? '自动化/代理消息' : null,
    phase: data.phase ?? null, attachments
  };
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function safeFilename(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const clean = rawPath.replace(/\\/g, '/');
  return path.basename(clean).slice(0, 100);
}

function fileIcon(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.py') return '🐍';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return '📜';
  if (['.html', '.htm', '.css', '.vue', '.svelte'].includes(ext)) return '🌐';
  if (['.sh', '.bat', '.cmd', '.ps1'].includes(ext)) return '⚡';
  if (['.json', '.yml', '.yaml', '.toml', '.md', '.txt'].includes(ext)) return '📄';
  return '📄';
}

function parseToolInfo(data) {
  const name = typeof data.toolName === 'string' ? data.toolName : '';
  const args = data.arguments;

  if (typeof args === 'string') {
    const patchMatch = args.match(/(?:Update|Add|Delete) File:\s*([^\r\n]+)/);
    if (patchMatch) {
      const file = safeFilename(patchMatch[1].trim());
      const icon = fileIcon(file) === '📄' ? '✏️' : fileIcon(file);
      return { icon, title: `Patch ${file}` };
    }
    return { icon: '✏️', title: 'Apply patch' };
  }

  const obj = args && typeof args === 'object' ? args : {};
  if (name === 'view') {
    const file = safeFilename(obj.path || obj.file);
    return { icon: file ? fileIcon(file) : '📄', title: file ? `View ${file}` : 'View file' };
  }
  if (name === 'edit') {
    const file = safeFilename(obj.path || obj.file);
    return { icon: file ? (fileIcon(file) === '📄' ? '✏️' : fileIcon(file)) : '✏️', title: file ? `Edit ${file}` : 'Edit file' };
  }
  if (name === 'apply_patch') {
    const file = safeFilename(obj.path || obj.file);
    return { icon: file ? (fileIcon(file) === '📄' ? '✏️' : fileIcon(file)) : '✏️', title: file ? `Patch ${file}` : 'Apply patch' };
  }
  if (['powershell', 'bash', 'cmd', 'shell'].includes(name)) {
    if (typeof obj.description === 'string' && obj.description.trim()) {
      return { icon: '⚡', title: `Run: ${obj.description.trim().slice(0, 50)}` };
    }
    if (typeof obj.command === 'string' && obj.command.trim()) {
      const clean = obj.command.replace(/^\$env:\w+=[^;]+;\s*/, '').trim();
      const firstLine = clean.split('\n')[0].trim().slice(0, 40);
      return { icon: '⚡', title: `Run: ${firstLine || 'command'}` };
    }
    return { icon: '⚡', title: 'Running command' };
  }
  if (['rg', 'grep'].includes(name)) {
    const pattern = typeof obj.pattern === 'string' ? obj.pattern.trim() : '';
    return { icon: '🔍', title: pattern ? `Search: ${pattern.slice(0, 40)}` : 'Search files' };
  }
  if (name === 'glob') {
    const pattern = typeof obj.pattern === 'string' ? obj.pattern.trim() : '';
    return { icon: '📁', title: pattern ? `Find: ${pattern.slice(0, 40)}` : 'Find files' };
  }
  if (name === 'read_powershell') {
    return { icon: '⚡', title: 'Read command output' };
  }
  if (name === 'create') {
    const file = safeFilename(obj.path || obj.file);
    return { icon: '➕', title: file ? `Create ${file}` : 'Create file' };
  }
  if (name === 'task') {
    const desc = typeof obj.description === 'string' ? obj.description.trim() : '';
    return { icon: '🤖', title: desc ? `Agent: ${desc.slice(0, 50)}` : 'Task agent' };
  }
  return {
    icon: '⚙️',
    title: (typeof data.toolTitle === 'string' && data.toolTitle.trim()) ? data.toolTitle.trim() : (name || 'Tool')
  };
}

const gitCache = new Map();
function getGitChanges(cwd) {
  if (!cwd) return Promise.resolve(null);
  const now = Date.now();
  const cached = gitCache.get(cwd);
  if (cached && now - cached.time < 3000) return Promise.resolve(cached.value);
  return new Promise(resolve => {
    execFile('git', ['--no-pager', 'diff', '--shortstat'], { cwd, timeout: 1500 }, (err, stdout) => {
      if (err || !stdout) {
        gitCache.set(cwd, { time: now, value: null });
        return resolve(null);
      }
      const ins = stdout.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? '0';
      const del = stdout.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? '0';
      const value = (ins !== '0' || del !== '0') ? `+${ins} -${del}` : null;
      gitCache.set(cwd, { time: now, value });
      resolve(value);
    });
  });
}

async function countArtifacts(filesDir) {
  try {
    const entries = await readdir(filesDir, { withFileTypes: true });
    return entries.filter(e => !e.name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

export function checkSessionBusy(root, sessionId) {
  if (!uuid.test(sessionId ?? '')) return false;
  try {
    const eventsPath = path.join(root, sessionId, 'events.jsonl');
    const stat = statSync(eventsPath);
    if (!stat.isFile()) return false;
    // If not modified in 2 minutes, the session is not actively busy
    if (Date.now() - stat.mtimeMs > 120000) return false;
    const fd = openSync(eventsPath, 'r');
    const len = Math.min(stat.size, 16384);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, stat.size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'session.shutdown' || ev.type === 'session.suspend' || ev.type === 'assistant.turn_end') return false;
        if (ev.type === 'assistant.turn_start' || ev.type === 'tool.execution_start') return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

export function createHistoryReader({ root, targets, pageSize = 40 }) {
  const cache = new Map();
  const chains = new Map();
  async function read(request) {
    if (!uuid.test(request.id ?? '')) throw unavailable('无效会话 ID。');
    const target = targets().find(item => item.id === request.id);
    if (!target) throw unavailable('目标不在已验证的 App 会话列表中，请先刷新列表。');
    if (!target.path || typeof target.path !== 'string') throw unavailable('此目标没有可验证的本机运行目录；云端或远程历史暂不可用。');
    const filePath = path.resolve(root, request.id, 'events.jsonl');
    if (path.dirname(path.dirname(filePath)) !== path.resolve(root)) throw unavailable('历史路径越界。');
    let file;
    try {
      await safePath(filePath);
      file = await open(filePath, 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink > 1) throw unavailable('历史不是独立普通文件。');
      const end = stat.size;
      let state = cache.get(request.id);
      const prefixSize = Math.min(end, 512);
      const prefix = digest(await readAt(file, 0, prefixSize));
      if (state && (state.ino !== stat.ino || state.dev !== stat.dev || end < state.end ||
          digest(await readAt(file, 0, state.prefixSize)) !== state.prefix ||
          digest(await readAt(file, Math.max(0, state.offset - state.tailSize), state.tailSize)) !== state.tail)) {
        cache.delete(request.id);
        throw changed();
      }
      if (!state) {
        state = { generation: randomUUID(), ino: stat.ino, dev: stat.dev, end: 0, offset: 0, messages: [], tools: new Map(), runningTools: new Set(), activeTurn: null, completions: new Map(), textBytes: 0, ids: new Set(), prefix, prefixSize, tailSize: 0, tail: digest(Buffer.alloc(0)), validated: false };
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
      }
      if (state.cwd && path.resolve(target.path).toLowerCase() !== state.cwd) throw unavailable('App 目录与已验证的历史映射不一致。');
      const cursor = value => {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'string' || !/^[0-9a-f-]{36}:\d+$/.test(value)) throw invalid('无效历史游标。');
        const [generation, index] = value.split(':');
        const number = Number(index);
        if (generation !== state.generation || !Number.isSafeInteger(number) || number > state.messages.length) throw changed();
        return number;
      };
      const before = cursor(request.before);
      const after = cursor(request.after);
      if (before !== null && after !== null) throw invalid('不能同时使用前后游标。');
      let pending = Buffer.alloc(0);
      let position = state.offset;
      let committed = state.offset;
      while (position < end) {
        const chunk = await readAt(file, position, Math.min(65536, end - position));
        position += chunk.length;
        pending = Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline);
          if (line.length > 16 * 1024 * 1024) throw invalid('单条历史事件超过安全读取限制。');
          pending = pending.subarray(newline + 1);
          committed += newline + 1;
          if (!line.length) throw invalid('历史包含空的完整记录。');
          let event;
          try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
          catch { throw invalid('历史完整行不是有效 UTF-8 JSON；未跳过。'); }
          if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.timestamp !== 'string' ||
              !Number.isFinite(Date.parse(event.timestamp)) || !event.data || typeof event.data !== 'object') throw invalid('未知历史事件结构。');
          if (!state.validated || event.type === 'session.start') {
            if (event.type !== 'session.start' || event.data.version !== 1 || event.data.sessionId !== request.id ||
                typeof event.data.context?.cwd !== 'string' ||
                path.resolve(event.data.context.cwd).toLowerCase() !== path.resolve(target.path).toLowerCase()) {
              throw unavailable('无法核验 App ID、runtime ID、版本与目录映射；未猜测其它路径。');
            }
            state.validated = true;
            state.cwd = path.resolve(target.path).toLowerCase();
          }
          let message = visibleMessage(event);
          if (event.type === 'assistant.turn_start') {
            state.activeTurn = { turnId: event.data?.turnId, startedAt: event.timestamp };
          } else if (event.type === 'assistant.turn_end') {
            state.activeTurn = null;
            for (const callId of state.runningTools) {
              const t = state.tools.get(callId);
              if (t && t.status === 'running') t.status = 'completed';
            }
            state.runningTools.clear();
          } else if (event.type === 'tool.execution_start') {
            const toolCallId = event.data?.toolCallId;
            const toolName = event.data?.toolName;
            if (typeof toolCallId === 'string' && toolName !== 'task_complete' && !state.completions.has(toolCallId)) {
              const info = parseToolInfo(event.data);
              const toolMsg = {
                id: event.id, messageId: `tool:${toolCallId}`, role: 'tool',
                toolCallId, toolName: event.data.toolName, content: info.title, title: info.title, icon: info.icon,
                status: 'running', startedAt: event.timestamp, completedAt: null, durationText: null,
                timestamp: event.timestamp
              };
              state.tools.set(toolCallId, toolMsg);
              state.runningTools.add(toolCallId);
              if (!state.ids.has(toolMsg.messageId)) {
                state.ids.add(toolMsg.messageId);
                state.messages.push(toolMsg);
                state.textBytes += Buffer.byteLength(info.title, 'utf8');
              }
            }
          } else if (event.type === 'assistant.message') {
            if (event.data.toolRequests !== undefined && !Array.isArray(event.data.toolRequests)) throw invalid('未知助手工具请求结构。');
            for (const request of event.data.toolRequests ?? []) {
              if (request.name?.replace(/^functions\./, '') !== 'task_complete') continue;
              if (typeof request.toolCallId !== 'string' || typeof request.arguments?.summary !== 'string') throw invalid('未知完成摘要结构。');
              if (request.arguments.summary !== event.data.content) state.completions.set(request.toolCallId, {
                summary: request.arguments.summary, messageId: `${event.data.messageId}:completion:${request.toolCallId}`
              });
            }
          } else if (event.type === 'tool.execution_complete') {
            if (state.completions.has(event.data.toolCallId)) {
              const completion = state.completions.get(event.data.toolCallId);
              state.completions.delete(event.data.toolCallId);
              if (typeof event.data.success !== 'boolean') throw invalid('未知完成摘要执行结果。');
              if (event.data.success && completion.summary.trim()) message = {
                id: event.id, messageId: completion.messageId, role: 'assistant', content: completion.summary,
                timestamp: event.timestamp, source: '完成摘要', phase: 'final_answer', attachments: []
              };
            } else if (typeof event.data.toolCallId === 'string' && state.tools.has(event.data.toolCallId)) {
              const tool = state.tools.get(event.data.toolCallId);
              state.runningTools.delete(event.data.toolCallId);
              tool.status = event.data.success ? 'completed' : 'failed';
              tool.completedAt = event.timestamp;
              const ms = Math.max(0, Date.parse(event.timestamp) - Date.parse(tool.startedAt));
              tool.duration = ms / 1000;
              tool.durationText = formatDuration(ms);
            }
          }
          if (message) {
            if (state.ids.has(message.messageId)) throw invalid('历史包含重复消息 ID。');
            state.ids.add(message.messageId);
            state.messages.push(message);
            state.textBytes += Buffer.byteLength(message.content, 'utf8');
            if (state.messages.length > 100000 || state.textBytes > 16 * 1024 * 1024) throw invalid('历史消息超出安全索引容量。');
          }
        }
        if (pending.length > 16 * 1024 * 1024) throw invalid('单条历史事件超过安全读取限制。');
      }
      if (!state.validated) throw unavailable('历史尚无可验证的完整 session.start。');
      state.offset = committed;
      state.end = end;
      state.prefix = prefix;
      state.prefixSize = prefixSize;
      state.tailSize = Math.min(committed, 256);
      state.tail = digest(await readAt(file, committed - state.tailSize, state.tailSize));
      const finalStat = await file.stat();
      await safePath(filePath);
      const pathStat = await lstat(filePath);
      if (finalStat.ino !== stat.ino || finalStat.size < end ||
          pathStat.ino !== stat.ino || pathStat.dev !== stat.dev ||
          digest(await readAt(file, 0, prefixSize)) !== prefix) throw changed();
      cache.set(request.id, state);
      const finish = before ?? (after !== null ? Math.min(state.messages.length, after + pageSize) : state.messages.length);
      let start = after ?? Math.max(0, finish - pageSize);
      if (after !== null) {
        let lookback = after;
        while (lookback > 0 && state.messages[lookback - 1]?.role === 'tool') {
          lookback--;
          if (after - lookback >= 10) break;
        }
        start = lookback;
      }
      const isBusy = Boolean(state.activeTurn) || state.runningTools.size > 0;
      const busyForSeconds = state.activeTurn
        ? Math.max(0, Math.round((Date.now() - Date.parse(state.activeTurn.startedAt)) / 1000))
        : 0;
      let activeTool = null;
      if (state.runningTools.size > 0) {
        const lastCallId = Array.from(state.runningTools).pop();
        const t = state.tools.get(lastCallId);
        if (t) activeTool = { name: t.toolName, title: t.title, icon: t.icon, startedAt: t.startedAt };
      }
      const gitChanges = await getGitChanges(target.path);
      const artifactsCount = await countArtifacts(path.join(root, request.id, 'files'));
      return { id: request.id, messages: state.messages.slice(start, finish),
        progress: {
          status: isBusy ? 'busy' : 'idle',
          busyForSeconds,
          activeTool,
          changes: gitChanges,
          artifacts: artifactsCount
        },
        before: start ? `${state.generation}:${start}` : null,
        after: `${state.generation}:${finish}`, hasMoreNew: finish < state.messages.length,
        snapshotBytes: end, committedBytes: committed, incompleteTail: end > committed,
        source: 'local-events-v1', completeAppHistory: false };
    } catch (error) {
      if (!(error instanceof AppError)) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw unavailable('本机会话历史不存在或无法读取。');
        cache.delete(request.id);
        console.error(`History read failed: ${error.message}`);
        throw invalid('历史读取失败；未返回不完整的成功结果。');
      }
      if (['HISTORY_INVALID', 'HISTORY_CHANGED'].includes(error.code)) cache.delete(request.id);
      throw error;
    } finally { await file?.close(); }
  }
  return request => {
    const previous = chains.get(request.id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => read(request));
    chains.set(request.id, result);
    result.finally(() => { if (chains.get(request.id) === result) chains.delete(request.id); }).catch(() => {});
    return result;
  };
}
