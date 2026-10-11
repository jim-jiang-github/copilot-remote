export const terminalStates = new Set(['app_accepted', 'app_created', 'failed', 'cancelled', 'unknown']);

export function appendAudit(record, event, details = {}) {
  record.audit ??= [];
  record.audit.push({ at: new Date().toISOString(), event, ...details });
  if (record.audit.length > 100) record.audit.shift();
}

export function markStopped(record, { aborted = false, reason = '', requestId } = {}) {
  if (!record || (requestId && record.requestId !== requestId) || terminalStates.has(record.status)) return false;
  if (record.dispatchAuthorized || record.invoked) {
    record.status = 'unknown';
    record.error = '中转已停止，投递调用可能已执行但没有 App 回执；请检查目标，不会自动重发。';
  } else {
    record.status = aborted ? 'cancelled' : 'failed';
    record.error = aborted
      ? '中转已取消，尚未执行投递。运行时报告停止，但无法据此确定是手动取消还是 App 调度中断。'
      : '协调助手已结束，但尚未执行投递；目标没有拒绝消息。';
  }
  appendAudit(record, 'stopped', { aborted, reason });
  return true;
}

export function applyAdmission(record, result) {
  const text = result?.textResultForLlm ?? result?.sessionLog ?? '';
  record.appReceipt = text;
  if (result?.resultType === 'success' && typeof text === 'string' && text.startsWith('Message accepted for ')) {
    record.status = 'app_accepted';
    record.acceptedAt = new Date().toISOString();
    delete record.error;
  } else {
    record.status = 'unknown';
    record.error = '投递工具已返回，但未取得可识别的 App 接受回执；请检查目标，不会自动重发。';
  }
  appendAudit(record, 'app_tool_result', { resultType: result?.resultType ?? 'missing', accepted: record.status === 'app_accepted' });
}

export function payloadReference(requestId) {
  return `REMOTE_PAYLOAD_${requestId}`;
}

export function matchesForwardIntent(input, context) {
  const args = input.toolArgs;
  return input.toolName?.replace(/^functions\./, '') === 'send_session_message' && context?.type === 'send' &&
    args?.session_id === context.id && (args.message === payloadReference(context.requestId) || args.message === context.text) &&
    (!args.delivery_mode || args.delivery_mode === 'immediate') &&
    Object.keys(args).every(key => ['session_id', 'message', 'delivery_mode'].includes(key));
}

export function exactDispatchArgs(context) {
  return { session_id: context.id, message: context.text, delivery_mode: 'immediate' };
}
