const $ = id => document.getElementById(id);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame = 0;
setInterval(() => {
  spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
  const spinners = document.querySelectorAll('.session-spinner');
  for (const el of spinners) {
    el.textContent = SPINNER_FRAMES[spinnerFrame];
  }
}, 80);

let snapshot = null;
let pending = false;
let connected = false;
let ownSelection = null;
let uncertain = false;
let lastRequest = null;
let receiptTimer = null;
let needsSetup = false;
const drafts = new Map();
const groupOpen = new Map();
let historyState = null;
let historyEpoch = 0;
let historyBusy = false;
let historyTimer = null;
let transcriptSignature = null;
let snapshotTimer = null;
const stagedImages = [];

function renderImagePreviews() {
  const container = $('image-previews');
  if (!container) return;
  if (!stagedImages.length) {
    container.hidden = true;
    container.replaceChildren();
    updateControls();
    return;
  }
  container.hidden = false;
  container.replaceChildren();
  stagedImages.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'image-preview-item';
    const img = document.createElement('img');
    img.src = item.previewUrl;
    img.alt = item.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remove-btn';
    btn.textContent = '×';
    btn.title = '移除图片';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      URL.revokeObjectURL(item.previewUrl);
      stagedImages.splice(index, 1);
      renderImagePreviews();
    });
    card.append(img, btn);
    container.append(card);
  });
  updateControls();
}

async function handleImageFiles(fileList) {
  if (!fileList || !fileList.length) return;
  for (const file of fileList) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 15 * 1024 * 1024) {
      status('图片过大，单张限制 15MB', true);
      continue;
    }
    const previewUrl = URL.createObjectURL(file);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const parts = reader.result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    stagedImages.push({
      file,
      name: file.name || 'image.png',
      type: file.type || 'image/png',
      data,
      previewUrl
    });
  }
  renderImagePreviews();
}

function updateSnapshotData(data) {
  if (!data || !Array.isArray(data.sessions)) return;
  snapshot = { ...snapshot, ...data };
  for (const session of data.sessions) {
    const isBusy = Boolean(session.busy || (session.id === ownSelection && historyState?.progress?.status === 'busy'));
    const btn = document.querySelector(`.session[data-session-id="${session.id}"]`);
    if (btn) {
      btn.classList.toggle('busy', isBusy);
      const icon = btn.querySelector('.session-icon');
      if (icon) {
        icon.classList.toggle('busy', isBusy);
        icon.classList.toggle('session-spinner', isBusy);
        if (!isBusy) icon.textContent = '';
      }
    }
  }
}

function scheduleSnapshotPoll() {
  clearTimeout(snapshotTimer);
  if (!connected) return;
  const anyBusy = snapshot?.sessions?.some(s => s.busy) || historyState?.progress?.status === 'busy';
  snapshotTimer = setTimeout(async () => {
    try {
      if (connected && !pending) {
        const data = await api('snapshot');
        updateSnapshotData(data);
      }
    } catch {}
    finally { scheduleSnapshotPoll(); }
  }, anyBusy ? 1500 : 3000);
}

async function api(route, body) {
  let response;
  try {
    response = await fetch(`/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });
  } catch {
    const error = new Error('连接中断。若刚发送消息，请先检查电脑对话，不要重复发送。');
    error.code = 'NETWORK_UNKNOWN';
    throw error;
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== 'login') showLogin();
    const error = new Error(data.error || '操作失败');
    error.code = data.code;
    throw error;
  }
  return data;
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function setBusy(value) {
  pending = value;
  updateControls();
  renderSessions();
}
function updateControls() {
  const selected = snapshot?.sessions?.find(item => item.id === ownSelection);
  const valid = connected && selected && ownSelection === selected.id;
  $('title').textContent = selected?.title ?? '选择一个会话';
  $('subtitle').textContent = selected ? `App 会话 · ${selected.id.slice(0, 8)}` : '网页选中不会切换 PC 页面';
  $('message').disabled = pending || !valid || uncertain;
  const hasContent = Boolean($('message').value.trim() || stagedImages.length > 0);
  $('send').disabled = pending || !valid || uncertain || snapshot?.activeRequestId || snapshot?.refreshing || !hasContent;
  if ($('attach-image-btn')) $('attach-image-btn').disabled = pending || !valid || uncertain;
  $('refresh').disabled = pending;
  if (snapshot?.refreshing || snapshot?.activeRequestId) $('refresh').disabled = true;
  $('create-session').disabled = pending || !connected || uncertain || Boolean(snapshot?.activeRequestId) || snapshot?.refreshing;
  $('project-create').disabled = $('create-session').disabled;
  $('logout').disabled = pending;
  $('counter').textContent = `${$('message').value.length} / 8000`;
  $('message').placeholder = valid ? '向此 Copilot 对话发送文本…' : '先选择一个会话…';
  $('target-label').textContent = valid ? `发送到：${selected.title}` : '请确认并选择目标会话';
}
function sidebar(open) {
  $('sidebar').classList.toggle('open', open);
  $('backdrop').hidden = !open;
  $('open-sidebar').setAttribute('aria-expanded', String(open));
}
function renderSessions() {
  $('sessions').replaceChildren();
  const search = $('search').value.toLocaleLowerCase();
  const sessions = snapshot?.sessions ?? [];
  function sessionButton(session) {
    const isBusy = Boolean(session.busy || (session.id === ownSelection && historyState?.progress?.status === 'busy'));
    const button = document.createElement('button');
    button.className = `session${session.id === ownSelection ? ' active' : ''}${isBusy ? ' busy' : ''}`;
    button.type = 'button';
    button.dataset.sessionId = session.id;
    button.disabled = pending;
    button.setAttribute('aria-current', session.id === ownSelection ? 'true' : 'false');
    const icon = document.createElement('span');
    icon.className = `session-icon${isBusy ? ' busy session-spinner' : ''}`;
    icon.textContent = isBusy ? SPINNER_FRAMES[spinnerFrame] : '';
    const copy = document.createElement('span');
    copy.className = 'session-copy';
    const name = document.createElement('strong');
    name.textContent = session.title;
    const detail = document.createElement('small');
    detail.textContent = session.description;
    button.title = `${session.title} · ${session.description}`;
    copy.append(name);
    button.append(icon, copy);
    button.addEventListener('click', () => selectSession(session));
    return button;
  }
  if (search) {
    for (const session of sessions.filter(item => item.title.toLocaleLowerCase().includes(search))) $('sessions').append(sessionButton(session));
  } else {
    const byId = new Map(sessions.map(item => [item.id, item]));
    const children = new Map();
    const roots = [];
    for (const item of sessions) {
      if (item.parentId && item.parentId !== item.id && byId.has(item.parentId)) {
        const siblings = children.get(item.parentId) ?? [];
        siblings.push(item);
        children.set(item.parentId, siblings);
      } else roots.push(item);
    }
    const visited = new Set();
    function branch(item) {
      if (visited.has(item.id)) return document.createDocumentFragment();
      visited.add(item.id);
      const node = document.createElement('div');
      node.className = 'tree-branch';
      node.append(sessionButton(item));
      const nested = children.get(item.id);
      if (nested?.length) {
        const container = document.createElement('div');
        container.className = 'tree-children';
        container.setAttribute('aria-label', `${item.title} 的子会话`);
        for (const child of nested) container.append(branch(child));
        node.append(container);
      }
      return node;
    }
    const groups = new Map([['chats', { name: 'Chats', items: [] }]]);
    for (const item of sessions) {
      if (item.projectId && item.projectName && !groups.has(item.projectId)) groups.set(item.projectId, { name: item.projectName, items: [] });
    }
    for (const root of roots) {
      const key = root.kind === 'chat' ? 'chats' : root.projectId ?? 'unassociated';
      const group = groups.get(key) ?? { name: '未关联项目的会话', items: [] };
      group.items.push(root);
      groups.set(key, group);
    }
    for (const [key, { name, items }] of groups) {
      const details = document.createElement('details');
      details.className = 'tree-group';
      details.open = groupOpen.get(key) ?? true;
      const summary = document.createElement('summary');
      const icon = document.createElement('span');
      icon.className = key === 'chats' ? 'tree-chat-icon' : 'tree-folder-icon';
      icon.setAttribute('aria-hidden', 'true');
      summary.append(icon, document.createTextNode(name));
      details.append(summary);
      for (const item of items) details.append(branch(item));
      details.addEventListener('toggle', () => groupOpen.set(key, details.open));
      $('sessions').append(details);
    }
    for (const item of sessions) if (!visited.has(item.id)) $('sessions').append(branch(item));
  }
  if (!sessions.length) {
    const note = document.createElement('p');
    note.textContent = snapshot?.listError ?? '点击刷新，后台读取现有 App 会话；无需展开 PC 侧边栏。';
    $('sessions').append(note);
  }
}
function renderProgress() {
  const statsEl = $('session-stats');
  if (!statsEl) return;
  const prog = historyState?.progress;
  if (!prog || (!prog.activeTool && !prog.changes && !prog.artifacts && prog.status !== 'busy')) {
    statsEl.hidden = true;
    return;
  }
  statsEl.hidden = false;
  statsEl.replaceChildren();

  if (prog.status === 'busy' || prog.activeTool) {
    const busyPill = document.createElement('span');
    busyPill.className = 'stat-pill busy';
    const toolDesc = prog.activeTool ? `${prog.activeTool.icon || '⚡'} ${prog.activeTool.title}` : '正在处理…';
    const elapsed = prog.busyForSeconds || 0;
    busyPill.textContent = `● ${toolDesc}${elapsed > 0 ? ` (${elapsed}s)` : ''}`;
    statsEl.append(busyPill);
  }
  if (prog.changes) {
    const changesPill = document.createElement('span');
    changesPill.className = 'stat-pill changes';
    changesPill.textContent = `Changes ${prog.changes}`;
    statsEl.append(changesPill);
  }
  if (prog.artifacts) {
    const artPill = document.createElement('span');
    artPill.className = 'stat-pill';
    artPill.textContent = `Artifacts ${prog.artifacts}`;
    statsEl.append(artPill);
  }
}

function renderTranscript() {
  const signature = JSON.stringify([ownSelection, historyState?.messages, historyState?.progress, snapshot?.deliveries, snapshot?.transcript]);
  if (signature === transcriptSignature) return;
  transcriptSignature = signature;
  renderProgress();
  const conversation = $('conversation');
  const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
  const oldTop = conversation.scrollTop;
  $('conversation').replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'transcript-heading';
  heading.textContent = historyState ? '本机已落盘历史 · 包含实时工具执行进度' : '网页投递记录 · 尚未加载 App 历史';
  $('conversation').append(heading);
  const receiptLabels = {
    app_accepted: 'App 已接受后台投递 · 目标是否处理尚未确认',
    cancelled: '中转已取消，尚未执行投递',
    failed: '尚未完成投递',
    unknown: '结果未知 · 不会自动重发',
    submitting: '正在提交给协调助手',
    coordinator_queued: '协调助手排队中',
    invoking: '正在调用 App 后台投递'
  };
  const unmatchedHistoryUsers = [];
  for (const message of historyState?.messages ?? []) {
    if (message.role === 'tool') {
      const card = document.createElement('div');
      card.className = `tool-card status-${message.status}`;
      card.dataset.messageId = message.messageId;
      const icon = document.createElement('span');
      icon.className = 'tool-icon';
      icon.textContent = message.icon || '⚙️';
      const title = document.createElement('span');
      title.className = 'tool-title';
      title.textContent = message.title || message.content;
      const duration = document.createElement('span');
      duration.className = `tool-duration${message.status === 'running' ? ' running' : ''}`;
      if (message.status === 'running') {
        const elapsed = message.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(message.startedAt)) / 1000)) : 0;
        duration.textContent = `运行中${elapsed > 0 ? ` · ${elapsed}s` : '…'}`;
      } else {
        duration.textContent = message.durationText || '已完成';
      }
      card.append(icon, title, duration);
      conversation.append(card);
      continue;
    }
    const element = document.createElement('div');
    element.className = `transcript-line history-message${message.role === 'user' ? ' user' : ''}`;
    element.dataset.messageId = message.messageId;
    const content = document.createElement('div');
    content.className = 'history-content';
    content.textContent = message.content;
    element.append(content);

    if (message.attachments?.length) {
      const gallery = document.createElement('div');
      gallery.className = 'message-attachment-gallery';
      for (const item of message.attachments) {
        const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(item.name) || (item.filename && /\.(png|jpe?g|gif|webp|svg)$/i.test(item.filename));
        if (isImg) {
          const link = document.createElement('a');
          const fileName = item.filename || item.name;
          link.href = `/api/attachment?name=${encodeURIComponent(fileName)}&session=${encodeURIComponent(ownSelection)}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const img = document.createElement('img');
          img.className = 'attachment-thumb';
          img.src = `/api/attachment?name=${encodeURIComponent(fileName)}&session=${encodeURIComponent(ownSelection)}`;
          img.alt = item.name;
          img.title = item.name;
          img.addEventListener('error', () => {
            img.style.display = 'none';
            link.className = 'attachment-pill';
            link.textContent = `📎 ${item.name}`;
          });
          link.append(img);
          gallery.append(link);
        } else {
          const pill = document.createElement('span');
          pill.className = 'attachment-pill';
          pill.textContent = `📎 ${item.name}`;
          gallery.append(pill);
        }
      }
      element.append(gallery);
    }

    const metadata = document.createElement('small');
    metadata.className = 'message-metadata';
    metadata.textContent = `${message.role === 'user' ? '用户' : '助手'} · ${new Date(message.timestamp).toLocaleString()}${message.source ? ` · ${message.source}` : ''}${message.attachments?.length ? ` · ${message.attachments.map(item => item.name).join('、')}` : ''}`;
    element.append(metadata);
    conversation.append(element);
    if (message.role === 'user') unmatchedHistoryUsers.push(message);
  }
  const records = (snapshot?.deliveries ?? []).filter(item => item.id === ownSelection);
  const latestHistoryTimestamp = historyState?.messages?.length
    ? Math.max(...historyState.messages.map(m => Date.parse(m.timestamp) || 0))
    : 0;
  const lines = records.length ? records.flatMap(item => {
    const created = Date.parse(item.createdAt);
    const match = item.status === 'app_accepted' && Number.isFinite(created)
      ? unmatchedHistoryUsers.findIndex(message => message.content === item.text && Date.parse(message.timestamp) >= created)
      : -1;
    if (match >= 0) unmatchedHistoryUsers.splice(match, 1);
    if (historyState) {
      if (match >= 0) return [];
      const isTerminal = ['unknown', 'failed', 'cancelled'].includes(item.status);
      if (isTerminal) {
        const isActive = lastRequest?.requestId === item.requestId;
        const isRecent = Number.isFinite(created) && (Date.now() - created < 60000) && (created >= latestHistoryTimestamp);
        if (!isActive && !isRecent) return [];
      }
    }
    return [...(match >= 0 ? [] : [`You said: ${item.text}`]),
      `网页投递回执 · ${item.requestId.slice(0, 8)} · ${receiptLabels[item.status] ?? '等待 App 回执'}`];
  }) : snapshot?.transcript ?? [];
  if (!lines.length) {
    const empty = document.createElement('p');
    empty.textContent = ownSelection ? '目标已在网页选中。输入文本后可后台投递，不影响 PC 当前页面。' : '刷新并选择一个现有 App 会话。';
    $('conversation').append(empty);
  }
  let previousUser = null;
  for (const line of lines) {
    if (line === previousUser) { previousUser = null; continue; }
    const element = document.createElement('div');
    const isUser = line.startsWith('You said: ');
    element.className = `transcript-line${isUser ? ' user' : ''}`;
    element.textContent = isUser ? line.slice(10) : line;
    previousUser = isUser ? line.slice(10) : null;
    $('conversation').append(element);
  }
  conversation.scrollTop = follow ? conversation.scrollHeight : oldTop;
}
function scheduleHistory(epoch) {
  clearTimeout(historyTimer);
  const interval = historyState?.progress?.status === 'busy' ? 1000 : 3000;
  historyTimer = setTimeout(() => loadHistory('new', epoch), interval);
}
async function loadHistory(mode = 'recent', epoch = historyEpoch) {
  if (!ownSelection || epoch !== historyEpoch || historyBusy) return;
  const id = ownSelection;
  historyBusy = true;
  $('older-history').disabled = true;
  const oldHeight = $('conversation').scrollHeight;
  const oldTop = $('conversation').scrollTop;
  try {
    const cursor = mode === 'older' ? historyState?.before : mode === 'new' ? historyState?.after : null;
    const data = await api('history', { id, ...(cursor ? { [mode === 'older' ? 'before' : 'after']: cursor } : {}) });
    if (epoch !== historyEpoch || id !== ownSelection) return;
    if (data.id !== id || !Array.isArray(data.messages)) throw new Error('历史返回目标或结构不一致。');
    if (mode === 'recent' || !historyState) historyState = data;
    else if (mode === 'older') {
      const ids = new Set(historyState.messages.map(item => item.messageId));
      const added = data.messages.filter(item => !ids.has(item.messageId));
      historyState.messages = [...added, ...historyState.messages];
      historyState.before = data.before;
      if (data.progress) historyState.progress = data.progress;
    } else {
      for (const message of data.messages) {
        const idx = historyState.messages.findIndex(item => item.messageId === message.messageId);
        if (idx >= 0) {
          historyState.messages[idx] = message;
        } else {
          historyState.messages.push(message);
        }
      }
      if (data.progress) historyState.progress = data.progress;
      historyState.after = data.after;
    }
    $('history-status').textContent = '本机历史 · 自动同步工具进度与新回复，云端/远程记录可能不可用';
    $('reload-history').hidden = true;
    $('older-history').hidden = !historyState.before;
    const activeBtn = document.querySelector(`.session[data-session-id="${id}"]`);
    if (activeBtn) {
      const isBusy = Boolean(data.progress?.status === 'busy');
      activeBtn.classList.toggle('busy', isBusy);
      const icon = activeBtn.querySelector('.session-icon');
      if (icon) {
        icon.classList.toggle('busy', isBusy);
        icon.classList.toggle('session-spinner', isBusy);
        if (!isBusy) icon.textContent = '';
      }
    }
    renderTranscript();
    if (mode === 'older') $('conversation').scrollTop = oldTop + $('conversation').scrollHeight - oldHeight;
    if (mode === 'recent') $('conversation').scrollTop = $('conversation').scrollHeight;
    if (data.hasMoreNew && mode === 'new') {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => loadHistory('new', epoch), 20);
    } else scheduleHistory(epoch);
  } catch (error) {
    if (epoch !== historyEpoch) return;
    if (error.code === 'HISTORY_CHANGED') {
      historyState = null;
      $('older-history').hidden = true;
      renderTranscript();
    }
    $('history-status').textContent = `${error.code ?? 'HISTORY_ERROR'} · ${error.message}`;
    $('reload-history').hidden = false;
    clearTimeout(historyTimer);
  } finally {
    if (epoch === historyEpoch) { historyBusy = false; $('older-history').disabled = false; }
  }
}
async function refresh() {
  const data = await api('snapshot');
  connected = true;
  snapshot = data;
  updateSnapshotData(data);
  const target = data.sessions?.find(item => item.id === ownSelection);
  $('connection').textContent = '已连接 · App 后台中转';
  $('title').textContent = target?.title ?? '选择一个会话';
  $('subtitle').textContent = target ? `App 会话 · ${target.id.slice(0, 8)}` : '网页选中不会切换 PC 页面';
  if (data.listError) status(data.listError, true);
  else if (!uncertain && !lastRequest) {
    status(data.refreshing ? '协调助手正在读取现有 App 会话…' : ownSelection ? '网页目标已选定，不影响电脑焦点。' : '请刷新会话列表，再选择现有 App 会话。');
  }
  renderSessions();
  renderTranscript();
  if (lastRequest) showReceipt();
  updateControls();
  if (data.refreshing || data.activeRequestId) scheduleReceipt();
  scheduleSnapshotPoll();
}
function failure(error) {
  connected = false;
  $('connection').textContent = '操作失败 · 请检查桌面';
  status(`${error.code ?? 'ERROR'} · ${error.message}`, true);
  updateControls();
}
async function selectSession(session) {
  if (pending) return;
  if (ownSelection) drafts.set(ownSelection, $('message').value);
  setBusy(true);
  try {
    await api('select', { id: session.id });
    ownSelection = session.id;
    historyEpoch++;
    historyState = null;
    historyBusy = false;
    clearTimeout(historyTimer);
    $('history-status').textContent = '正在只读加载最近历史…';
    $('older-history').hidden = true;
    $('reload-history').hidden = true;
    uncertain = false;
    lastRequest = null;
    $('message').value = drafts.get(session.id) ?? '';
    await refresh();
    sidebar(false);
    loadHistory('recent');
  } catch (error) { failure(error); }
  finally { setBusy(false); renderSessions(); }
}
function showLogin() {
  historyEpoch++;
  historyState = null;
  historyBusy = false;
  clearTimeout(historyTimer);
  connected = false;
  snapshot = null;
  ownSelection = null;
  uncertain = false;
  lastRequest = null;
  clearTimeout(receiptTimer);
  drafts.clear();
  $('message').value = '';
  $('shell').hidden = true;
  $('login').hidden = false;
  $('password').value = '';
  updateControls();
}
async function enter() {
  $('login').hidden = true;
  $('shell').hidden = false;
  setBusy(true);
  try {
    await refresh();
    if (!snapshot?.sessions?.length && !snapshot?.refreshing && !snapshot?.listError) {
      await api('targets', {});
      await refresh();
      scheduleReceipt();
    }
  }
  catch (error) { failure(error); }
  finally { setBusy(false); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    const credentials = { username: $('username').value, password: $('password').value };
    if (needsSetup) {
      await api('setup', credentials);
      needsSetup = false;
    }
    await api('login', credentials);
    $('password').value = '';
    await enter();
  } catch (error) {
    try {
      const account = await api('account');
      if (account.needsSetup) {
        needsSetup = true;
        $('account-info').textContent = '首次使用：请创建自己的本地账号，密码至少12位。没有预设 admin 账号。';
        document.querySelector('#login-form button').textContent = '创建本地账号并登录';
        $('password').minLength = 12;
        $('login-error').textContent = '当前尚无本地账号，请用上面的表单创建账号后登录。';
      } else $('login-error').textContent = error.message;
    } catch { $('login-error').textContent = error.message; }
  }
  finally { button.disabled = false; }
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('send').disabled) return;
  const id = ownSelection;
  const text = $('message').value;
  setBusy(true);
  status('正在提交…');
  let delivered = false;
  try {
    let attachments = [];
    if (stagedImages.length) {
      status('正在上传图片…');
      const uploadRes = await api('upload', {
        files: stagedImages.map(img => ({
          name: img.name,
          type: img.type,
          data: img.data
        }))
      });
      attachments = uploadRes.files || [];
      for (const item of stagedImages) {
        URL.revokeObjectURL(item.previewUrl);
      }
      stagedImages.length = 0;
      renderImagePreviews();
    }
    lastRequest = { id, text, requestId: crypto.randomUUID(), attachments };
    status('正在提交给后台协调助手…');
    const data = await api('send', lastRequest);
    if (!data.submitted || data.requestId !== lastRequest.requestId) throw new Error('协调会话未返回接收凭证。');
    $('message').value = '';
    drafts.delete(id);
    await refresh();
    status('已提交给协调助手，等待 App 投递回执；尚不代表目标接收。');
    scheduleReceipt();
  } catch (error) {
    if (!delivered && ['DELIVERY_UNKNOWN', 'NETWORK_UNKNOWN', 'DELIVERY_PENDING'].includes(error.code)) {
      uncertain = true;
      error.message += ' 已锁定发送，请检查电脑后重新选择会话。';
    }
    failure(error);
  } finally { setBusy(false); }
});
$('message').addEventListener('input', () => {
  if (ownSelection) drafts.set(ownSelection, $('message').value);
  updateControls();
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!$('send').disabled) {
      if (typeof $('composer').requestSubmit === 'function') {
        $('composer').requestSubmit();
      } else {
        $('send').click();
      }
    }
  }
});
$('refresh').addEventListener('click', async () => {
  if (pending) return;
  setBusy(true);
  try { await api('targets', {}); await refresh(); scheduleReceipt(); } catch (error) { failure(error); } finally { setBusy(false); }
});
$('search').addEventListener('input', renderSessions);
$('toggle-search').addEventListener('click', () => {
  $('search-container').hidden = !$('search-container').hidden;
  if (!$('search-container').hidden) $('search').focus();
});
$('open-sidebar').addEventListener('click', () => sidebar(true));
$('close-sidebar').addEventListener('click', () => sidebar(false));
$('backdrop').addEventListener('click', () => sidebar(false));
$('older-history').addEventListener('click', () => loadHistory('older'));
$('conversation').addEventListener('scroll', () => {
  if ($('conversation').scrollTop < 60 && historyState?.before && !historyBusy) {
    loadHistory('older');
  }
});
if ($('attach-image-btn')) {
  $('attach-image-btn').addEventListener('click', () => {
    if (!ownSelection) return;
    $('image-input').click();
  });
}
if ($('image-input')) {
  $('image-input').addEventListener('change', async e => {
    await handleImageFiles(e.target.files);
    e.target.value = '';
  });
}
document.addEventListener('paste', async e => {
  if (!ownSelection) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    e.preventDefault();
    await handleImageFiles(files);
  }
});
['dragenter', 'dragover'].forEach(name => {
  document.addEventListener(name, e => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  });
});
document.addEventListener('drop', async e => {
  if (!ownSelection) return;
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    await handleImageFiles(files);
  }
});
$('reload-history').addEventListener('click', () => {
  historyEpoch++;
  historyBusy = false;
  historyState = null;
  loadHistory('recent');
});
$('logout').addEventListener('click', async () => {
  try { await api('logout', {}); showLogin(); } catch (error) { failure(error); }
});
$('create-session').addEventListener('click', () => {
  $('new-project').replaceChildren();
  const standalone = document.createElement('option');
  standalone.value = '';
  standalone.textContent = '独立聊天';
  $('new-project').append(standalone);
  const projects = new Map((snapshot?.sessions ?? []).filter(item => item.projectId && item.projectName).map(item => [item.projectId, item.projectName]));
  for (const [id, name] of projects) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    $('new-project').append(option);
  }
  $('create-error').textContent = '';
  $('new-name').value = '';
  $('create-dialog').showModal();
});
$('project-create').addEventListener('click', () => $('create-session').click());
$('cancel-create').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  const request = { name: $('new-name').value.trim(), projectId: $('new-project').value || null, requestId: crypto.randomUUID() };
  setBusy(true);
  try {
    const result = await api('create', request);
    if (!result.submitted || result.requestId !== request.requestId) throw new Error('未返回创建请求接收凭证。');
    lastRequest = { ...request, type: 'create' };
    $('create-dialog').close();
    status('已提交给协调助手，等待真实 App 创建结果…');
    scheduleReceipt();
  } catch (error) { $('create-error').textContent = `${error.code ?? 'ERROR'} · ${error.message}`; }
  finally { setBusy(false); }
});
try {
  const account = await api('account');
  needsSetup = account.needsSetup;
  if (needsSetup) {
    $('account-info').textContent = '首次使用：在电脑本机创建你自己的本地账号，密码至少12位。没有预设 admin 账号。';
    document.querySelector('#login-form button').textContent = '创建本地账号并登录';
    $('password').autocomplete = 'new-password';
    $('password').minLength = 12;
  } else {
    $('account-info').textContent = '本机已创建本地账号，请使用创建时设置的账号和密码登录；首次创建入口已关闭。不是 GitHub 密码。';
    document.querySelector('#login-form button').textContent = '登录控制面板';
    await enter();
  }
} catch (error) { $('login-error').textContent = error.message; }

function showReceipt() {
  const receipt = snapshot?.receipts?.find(item => item.requestId === lastRequest?.requestId);
  if (!receipt) return;
  if (receipt.status === 'app_created') {
    status('已通过 App 创建并查询确认新会话。');
    ownSelection = receipt.createdId;
    historyEpoch++;
    historyState = null;
    historyBusy = false;
    clearTimeout(historyTimer);
    loadHistory('recent');
    lastRequest = null;
    uncertain = false;
    $('message').value = '';
    renderSessions();
  } else if (receipt.status === 'app_accepted') {
    status('App 已接受后台投递（可能排队）；不代表目标已处理。');
    if ($('message').value === lastRequest.text) $('message').value = '';
    drafts.delete(lastRequest.id);
    lastRequest = null;
    uncertain = false;
  } else if (['unknown', 'failed', 'cancelled'].includes(receipt.status)) {
    uncertain = receipt.status === 'unknown';
    const label = receipt.status === 'unknown' ? '结果未知' : receipt.status === 'cancelled' ? '中转已取消，尚未执行投递' : '尚未完成投递';
    status(`${label}：${receipt.error ?? '请检查协调会话。'} 不会自动重发。`, true);
    if (receipt.status !== 'unknown') lastRequest = null;
  } else {
    status('协调助手正在后台投递，请等待 App 回执，不要重复发送。');
  }
  updateControls();
}
function scheduleReceipt() {
  clearTimeout(receiptTimer);
  receiptTimer = setTimeout(async () => {
    if ($('shell').hidden) return;
    try { await refresh(); } catch (error) { failure(error); }
    if (lastRequest || snapshot?.refreshing || snapshot?.activeRequestId) scheduleReceipt();
  }, 3000);
}
