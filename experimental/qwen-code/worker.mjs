import { mkdir, open, lstat, readFile, rename, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_APPROVAL_MODE, QwenError, isRecord, requireValue, sessionId, sha256,
  validatePrompt, validateRequestId, qwenLaunchSpec,
} from './contract.mjs';
import { runQwenProcess } from './process.mjs';

const STATE_VERSION = 2;
const COMPLETION_OUTCOMES = new Set(['completed', 'completed_with_denials']);
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_STATE_PATH', 'State directory must not be a symlink.');
  if (typeof process.getuid === 'function') requireValue(stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
    'UNSAFE_STATE_PATH', 'State directory must be owned by the current user and have mode 0700.');
}
async function readState(path) {
  let stat;
  try { stat = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size < 16 * 1024 * 1024, 'UNSAFE_STATE', 'Unexpected state file type or size.');
  if (typeof process.getuid === 'function') requireValue(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'UNSAFE_STATE', 'State file permissions are not private.');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new QwenError('CORRUPT_STATE', 'State cannot be decoded; preserve it and inspect rather than reset.'); }
}
async function atomicState(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  requireValue(Buffer.byteLength(text) < 16 * 1024 * 1024, 'STATE_CAPACITY', 'Worker state capacity reached; preserve/review history before more work.');
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600); await file.writeFile(text); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close(); await unlink(temp).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
}
function validResult(result) {
  return isRecord(result) && typeof result.text === 'string' && typeof result.actualModel === 'string'
    && COMPLETION_OUTCOMES.has(result.outcome) && Array.isArray(result.permissionDenials)
    && isRecord(result.usage) && Number.isSafeInteger(result.events) && result.events >= 0;
}
function validateState(state, worker) {
  requireValue(isRecord(state) && state.version === STATE_VERSION && state.workerId === worker.workerId && state.cwd === worker.cwd
    && isRecord(state.requests), 'STATE_MISMATCH', 'State belongs to another worker or unsupported Qwen state version. Preserve old state for review; do not auto-migrate receipts.');
  if (state.sessionId !== null) sessionId(state.sessionId);
  requireValue(state.actualModel === null || typeof state.actualModel === 'string', 'CORRUPT_STATE', 'Invalid recorded model.');
  for (const [id, request] of Object.entries(state.requests)) {
    validateRequestId(id);
    requireValue(isRecord(request) && ['pending', 'completed', 'blocked'].includes(request.status)
      && /^[a-f0-9]{64}$/u.test(request.fingerprint), 'CORRUPT_STATE', 'Invalid request receipt.');
    if (request.status === 'completed') {
      requireValue(validResult(request.result), 'CORRUPT_STATE', 'Invalid result receipt.');
      sessionId(request.result.sessionId);
    }
  }
  return state;
}

export async function runQwenWorker(workerInput, {
  prompt, requestId, executable, bootstrap = false, approvalMode = DEFAULT_APPROVAL_MODE,
  maxTurns = 40, maxToolCalls = 80, wallSeconds = 600, signal,
  stateRoot = join(homedir(), '.agentmux', 'qwen-code'), runProcess = runQwenProcess,
} = {}) {
  const worker = structuredClone(workerInput);
  validatePrompt(prompt); validateRequestId(requestId);
  requireValue(isRecord(worker) && worker.engine === 'qwen' && worker.instances === 1
    && worker.workerId === `qwen-${sha256(worker.cwd)}`, 'BAD_WORKER', 'Use a worker from the canonical fleet projection.');
  requireValue(await realpath(worker.cwd) === worker.cwd, 'REPO_CHANGED', 'Repository path changed since the fleet was planned.');
  requireValue(stateRoot === resolve(stateRoot), 'BAD_STATE_ROOT', 'State root must be absolute.');
  await privateDirectory(stateRoot);
  const directory = join(stateRoot, worker.workerId); await privateDirectory(directory);
  const lockPath = join(directory, 'owner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new QwenError('WORKER_LOCKED', 'One Qwen owner already exists or a previous owner stopped unexpectedly. No automatic lock stealing.'); throw e; }
  const owner = { pid: process.pid, hostname: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() };
  const statePath = join(directory, 'state.json');
  let state = null;
  try {
    await lock.writeFile(`${JSON.stringify(owner)}\n`); await lock.sync();
    const loaded = await readState(statePath);
    state = loaded === null ? { version: STATE_VERSION, workerId: worker.workerId, cwd: worker.cwd,
      sessionId: null, actualModel: null, requests: {} } : validateState(loaded, worker);
    const fingerprint = sha256(JSON.stringify({ cwd: worker.cwd, prompt,
      model: worker.configuredModel, approvalMode, maxTurns, maxToolCalls, wallSeconds }));
    const previous = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : null;
    if (previous !== null) {
      requireValue(previous.fingerprint === fingerprint, 'REQUEST_CONFLICT', 'Same request id was used for different work or budgets.');
      requireValue(previous.status === 'completed', 'OUTCOME_UNKNOWN', 'This request did not complete with a verified receipt. Inspect the exact session; do not resend automatically.');
      return { ...previous.result, replayed: true, workerId: worker.workerId, requestId };
    }
    requireValue(Object.values(state.requests).every((r) => r.status === 'completed'), 'OUTCOME_UNKNOWN', 'A previous turn is unresolved. No new work is started.');
    requireValue(Object.keys(state.requests).length < 1000, 'STATE_CAPACITY', '1000 receipts retained; reviewed rotation is required, never automatic deletion.');
    requireValue(worker.configuredModel == null || state.actualModel === null || worker.configuredModel === state.actualModel,
      'MODEL_CHANGE_BLOCKED', 'Changing the model of an owned Qwen session requires an explicit migration, not automatic restart.');
    const spec = qwenLaunchSpec({ executable, cwd: worker.cwd, resumeSessionId: state.sessionId,
      bootstrap, model: worker.configuredModel ?? state.actualModel, approvalMode, maxTurns, maxToolCalls, wallSeconds });
    requireValue(!signal?.aborted, 'CANCELLED', 'Cancelled before recording/submitting work.');
    const pending = { status: 'pending', fingerprint, startedAt: new Date().toISOString(),
      priorSessionId: state.sessionId, owner };
    Object.defineProperty(state.requests, requestId, { value: pending, enumerable: true, writable: true, configurable: true });
    await atomicState(statePath, state);
    let result;
    try {
      result = await runProcess(spec, prompt, { signal });
      sessionId(result.sessionId);
      requireValue(validResult(result), 'BAD_RESULT', 'Worker runner returned invalid completion data.');
      requireValue(state.sessionId === null || result.sessionId === state.sessionId, 'SESSION_MISMATCH', 'Completed result belongs to another session.');
      requireValue(spec.requestedModel === null || result.actualModel === spec.requestedModel, 'MODEL_MISMATCH', 'Completed result changed the requested model.');
    } catch (e) {
      pending.status = 'blocked'; pending.errorCode = e instanceof QwenError ? e.code : 'RUNNER_FAILED';
      pending.finishedAt = new Date().toISOString();
      await atomicState(statePath, state);
      if (e instanceof QwenError) throw e;
      throw new QwenError('RUNNER_FAILED', 'Worker failed; details retained by Qwen, outcome not assumed safe to retry.');
    }
    state.sessionId = result.sessionId; state.actualModel = result.actualModel;
    state.requests[requestId] = { ...pending, status: 'completed', finishedAt: new Date().toISOString(), result };
    await atomicState(statePath, state);
    return { ...result, replayed: false, workerId: worker.workerId, requestId };
  } finally {
    await lock.close();
    const actual = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    if (actual?.nonce === owner.nonce) await unlink(lockPath);
  }
}
