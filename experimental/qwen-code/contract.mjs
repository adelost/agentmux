import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const ENGINE = 'qwen';
export const DEFAULT_APPROVAL_MODE = 'auto';
export const APPROVAL_MODES = Object.freeze(['default', 'plan', 'auto-edit', 'auto', 'yolo']);
export const DISALLOWED_DELEGATION_TOOLS = Object.freeze(['agent', 'list_agents']);
export const LIMITS = Object.freeze({ promptBytes: 128 * 1024, lineBytes: 2 * 1024 * 1024,
  streamBytes: 32 * 1024 * 1024, resultBytes: 1024 * 1024 });
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const API_ERROR_RESULT = /^\s*\[API Error:/iu;
export class QwenError extends Error {
  constructor(code, message) { super(message); this.name = 'QwenError'; this.code = code; }
}
export function requireValue(ok, code, message) { if (!ok) throw new QwenError(code, message); }
export function sessionId(value) {
  requireValue(typeof value === 'string' && UUID.test(value), 'BAD_SESSION', 'An exact UUID session id is required.');
  return value;
}
export function validatePrompt(text) {
  requireValue(typeof text === 'string' && text.trim().length > 0 && !text.includes('\0')
    && Buffer.byteLength(text) <= LIMITS.promptBytes, 'BAD_PROMPT', 'Prompt must be nonempty UTF-8 text of at most 128 KiB.');
  requireValue(!text.trimStart().startsWith('/'), 'SLASH_UNSUPPORTED', 'Send slash commands in Qwen itself, not through the bounded worker.');
  return text;
}
export function validateRequestId(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value),
    'BAD_REQUEST_ID', 'Use an explicit stable request id (1..120 safe characters).');
  return value;
}
const optionalWhole = (value, label) => {
  if (value == null) return null;
  requireValue(Number.isSafeInteger(value) && value >= 0, 'BAD_RESULT', `Qwen ${label} must be a nonnegative safe integer.`);
  return value;
};
const safeToolName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);
function permissionDenials(value) {
  if (value == null) return Object.freeze([]);
  requireValue(Array.isArray(value) && value.length <= 256, 'BAD_RESULT', 'Qwen permission_denials must be a bounded array.');
  return Object.freeze(value.map((item) => {
    requireValue(isRecord(item) && safeToolName(item.tool_name), 'BAD_RESULT', 'Qwen permission denial lacks a safe tool name.');
    return Object.freeze({ toolName: item.tool_name });
  }));
}
function usageReceipt(value) {
  if (value == null) return Object.freeze({});
  requireValue(isRecord(value), 'BAD_RESULT', 'Qwen usage must be an object.');
  const names = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens'];
  return Object.freeze(Object.fromEntries(names.flatMap((name) => value[name] == null ? [] : [[name, optionalWhole(value[name], `usage.${name}`)]])));
}

export function qwenLaunchSpec({ executable, cwd, resumeSessionId = null, bootstrap = false,
  approvalMode = DEFAULT_APPROVAL_MODE, model = null, maxTurns = 40, maxToolCalls = 80, wallSeconds = 600 } = {}) {
  requireValue(typeof executable === 'string' && isAbsolute(executable) && !executable.includes('\0'), 'BAD_EXECUTABLE', 'Qwen executable must be an absolute path.');
  requireValue(typeof cwd === 'string' && isAbsolute(cwd) && !cwd.includes('\0'), 'BAD_CWD', 'A verified absolute repository directory is required.');
  requireValue(APPROVAL_MODES.includes(approvalMode), 'BAD_APPROVAL', `Approval mode must be one of ${APPROVAL_MODES.join(', ')}.`);
  requireValue(model === null || (typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(model)), 'BAD_MODEL', 'Invalid model id.');
  for (const [label, value, max] of [['maxTurns', maxTurns, 100], ['maxToolCalls', maxToolCalls, 200], ['wallSeconds', wallSeconds, 3600]]) {
    requireValue(Number.isSafeInteger(value) && value > 0 && value <= max, 'BAD_BUDGET', `${label} must be 1..${max}.`);
  }
  if (resumeSessionId !== null) sessionId(resumeSessionId);
  requireValue(resumeSessionId !== null || bootstrap === true, 'BOOTSTRAP_REQUIRED', 'No exact session exists; first run requires explicit --bootstrap.');
  const args = ['--input-format', 'text', '--output-format', 'stream-json', '--approval-mode', approvalMode,
    '--max-session-turns', String(maxTurns), '--max-tool-calls', String(maxToolCalls), '--max-wall-time', `${wallSeconds}s`];
  for (const tool of DISALLOWED_DELEGATION_TOOLS) args.push('--exclude-tools', tool);
  if (model !== null) args.push('--model', model);
  if (resumeSessionId !== null) args.push('--resume', resumeSessionId);
  return Object.freeze({ executable, args: Object.freeze(args), cwd, wallSeconds,
    approvalMode, requestedModel: model, resumeSessionId, nestedAgents: false });
}

export class QwenTurnReader {
  constructor({ expectedSession = null, expectedModel = null } = {}) {
    if (expectedSession !== null) sessionId(expectedSession);
    this.expectedSession = expectedSession; this.expectedModel = expectedModel;
    this.decoder = new StringDecoder('utf8'); this.pending = ''; this.bytes = 0;
    this.session = null; this.model = null; this.result = null;
    this.finished = false; this.events = 0;
  }
  push(chunk) {
    requireValue(!this.finished, 'CLOSED_STREAM', 'Stream already finalized.');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += bytes.length;
    requireValue(this.bytes <= LIMITS.streamBytes, 'STREAM_LIMIT', 'Qwen output exceeded the configured byte limit.');
    this.pending += this.decoder.write(bytes);
    let newline;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    requireValue(Buffer.byteLength(this.pending) <= LIMITS.lineBytes, 'LINE_LIMIT', 'Qwen event exceeds the byte limit.');
  }
  line(line) {
    if (!line.trim()) return;
    requireValue(Buffer.byteLength(line) <= LIMITS.lineBytes, 'LINE_LIMIT', 'Qwen event exceeds the byte limit.');
    let e; try { e = JSON.parse(line); } catch { throw new QwenError('BAD_JSONL', 'Qwen output is not valid JSONL. Raw output withheld.'); }
    requireValue(isRecord(e) && typeof e.type === 'string', 'BAD_EVENT', 'Qwen event lacks a type.');
    this.events++;
    if (e.parent_tool_use_id != null) throw new QwenError('SUBAGENT_UNEXPECTED', 'Nested Qwen agent activity is disabled for AMUX workers.');
    if (e.type === 'system' && e.subtype === 'session_start') {
      requireValue(this.session === null && !this.result, 'BAD_ORDER', 'Multiple Qwen session starts in one process.');
      this.session = sessionId(e.session_id);
      requireValue(this.expectedSession === null || this.session === this.expectedSession, 'SESSION_MISMATCH', 'Qwen resumed a different session; no fallback allowed.');
      requireValue(typeof e.model === 'string' && e.model.trim().length > 0, 'MODEL_UNKNOWN', 'Qwen did not report its actual model.');
      this.model = e.model;
      requireValue(this.expectedModel === null || e.model === this.expectedModel, 'MODEL_MISMATCH', 'Qwen reported a different model from the requested pin.');
      return;
    }
    requireValue(this.session !== null, 'NO_HANDSHAKE', 'Qwen event arrived before session_start.');
    if (e.session_id != null) requireValue(e.session_id === this.session, 'SESSION_MISMATCH', 'Event belongs to another Qwen session.');
    if (e.type === 'result') {
      requireValue(this.result === null, 'DUPLICATE_RESULT', 'More than one terminal result in a single-turn run.');
      requireValue(typeof e.session_id === 'string' && e.session_id === this.session, 'SESSION_MISMATCH', 'Terminal result must identify its exact session.');
      requireValue(typeof e.is_error === 'boolean' && typeof e.subtype === 'string', 'BAD_RESULT', 'Terminal result lacks outcome fields.');
      requireValue(e.subtype === 'success' && e.is_error === false, 'QWEN_FAILED', 'Qwen reported a failed turn; no retry or fresh-session fallback.');
      requireValue(typeof e.result === 'string' && Buffer.byteLength(e.result) <= LIMITS.resultBytes, 'BAD_RESULT', 'Missing or oversized terminal result.');
      requireValue(!API_ERROR_RESULT.test(e.result), 'QWEN_API_ERROR', 'Qwen reported an API error inside a nominal success result.');
      const denials = permissionDenials(e.permission_denials);
      const terminalReason = e.terminal_reason == null ? null : String(e.terminal_reason);
      requireValue(terminalReason === null || (terminalReason.length > 0 && terminalReason.length <= 128
        && !/[\u0000-\u001f\u007f]/u.test(terminalReason)), 'BAD_RESULT', 'Qwen terminal_reason is invalid.');
      this.result = Object.freeze({
        text: e.result,
        outcome: denials.length ? 'completed_with_denials' : 'completed',
        terminalSubtype: e.subtype,
        terminalReason,
        permissionDenials: denials,
        usage: usageReceipt(e.usage),
        numTurns: optionalWhole(e.num_turns, 'num_turns'),
        durationMs: optionalWhole(e.duration_ms, 'duration_ms'),
        durationApiMs: optionalWhole(e.duration_api_ms, 'duration_api_ms'),
      });
      return;
    }
    requireValue(this.result === null, 'AFTER_RESULT', 'Nonterminal activity after Qwen terminal result.');
    requireValue(['assistant', 'user', 'system', 'stream_event', 'tool_progress', 'control_request', 'control_response'].includes(e.type), 'UNKNOWN_EVENT', 'Unsupported Qwen event type; update adapter from upstream schema.');
    if (e.type === 'control_request') throw new QwenError('APPROVAL_REQUIRED', 'Qwen requested interactive approval; no automatic approval is sent.');
  }
  finish(exitCode, signal = null) {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.line(this.pending);
    this.pending = ''; this.finished = true;
    requireValue(exitCode === 0 && signal === null, 'PROCESS_FAILED', 'Qwen process did not exit successfully.');
    requireValue(this.result !== null, 'INCOMPLETE_RESULT', 'Qwen exited without a validated terminal result.');
    return Object.freeze({ sessionId: this.session, actualModel: this.model, ...this.result, events: this.events });
  }
}
