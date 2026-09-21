import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_APPROVAL_MODE, QwenTurnReader, qwenLaunchSpec } from '../contract.mjs';
import { planQwenFleet, selectQwenWorker } from '../fleet.mjs';
import { runQwenProcess, probeQwenExecutable } from '../process.mjs';
import { runQwenWorker } from '../worker.mjs';
import { main } from '../cli.mjs';

const sid = '12345678-1234-4234-8234-123456789abc';
const other = 'abcdefab-1234-4234-8234-123456789abc';
const code = (name) => (error) => error?.code === name;
const start = () => ({ type: 'system', subtype: 'session_start', session_id: sid, model: 'fixture-model' });
const done = (over = {}) => ({ type: 'result', subtype: 'success', session_id: sid, is_error: false,
  result: 'done', permission_denials: [], terminal_reason: 'completed', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, ...over });
const emit = (reader, event) => reader.push(`${JSON.stringify(event)}\n`);
const fakePath = fileURLToPath(new URL('./fake-qwen.mjs', import.meta.url));
const fakeSpawn = (spec) => (file, args, opts) => {
  assert.equal(file, spec.executable); assert.equal(opts.shell, false);
  return spawn(process.execPath, [fakePath, ...args], opts);
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'amux-qwen-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), stateRoot = join(root, 'state'); await mkdir(repo);
  const [worker] = planQwenFleet({ agents: { repo: { dir: repo, claude: 2, kimi: 1 } } });
  return { root, repo, stateRoot, worker };
}
const completed = (over = {}) => ({ sessionId: sid, actualModel: 'fixture-model', text: 'ok', outcome: 'completed',
  terminalSubtype: 'success', terminalReason: 'completed', permissionDenials: [], usage: {}, numTurns: 1,
  durationMs: 1, durationApiMs: 1, events: 2, ...over });
const workerOpts = (stateRoot, over = {}) => ({ stateRoot, executable: '/fixture/qwen', prompt: 'review',
  requestId: 'r1', bootstrap: true, runProcess: async () => completed(), ...over });

test('one worker per canonical repo and aliases deduplicate without mutation', () => {
  const doc = { agents: { a: { dir: '/a', claude: 2 }, alias: { dir: '/alias-a', kimi: 1 }, b: { dir: '/b' } } };
  const before = JSON.stringify(doc);
  const workers = planQwenFleet(doc, { resolveDirectory: (p) => p.includes('a') ? '/canonical/a' : p });
  assert.equal(workers.length, 2); assert.equal(selectQwenWorker(workers, 'a').workerId, selectQwenWorker(workers, 'alias').workerId);
  assert.equal(JSON.stringify(doc), before); assert.ok(workers.every((w) => w.instances === 1));
});
test('qwen:0 opts only that alias out; omitted/1 remains enabled', () => {
  const workers = planQwenFleet({ agents: { off: { dir: '/repo', qwen: 0 }, on: { dir: '/repo', qwen: 1 }, d: { dir: '/other' } } }, { resolveDirectory: (p) => p });
  assert.equal(workers.length, 2); assert.throws(() => selectQwenWorker(workers, 'off'), code('TARGET_UNKNOWN'));
  assert.equal(selectQwenWorker(workers, 'on').cwd, '/repo'); assert.equal(selectQwenWorker(workers, 'd').cwd, '/other');
});
for (const [label, doc, expected] of [
  ['multiple instances', { agents: { a: { dir: '/a', qwen: 2 } } }, 'QWEN_COUNT_CONFLICT'],
  ['disabled model', { agents: { a: { dir: '/a', qwen: 0, qwenModel: 'x' } } }, 'QWEN_DISABLED_CONFIG'],
  ['relative repo', { agents: { a: { dir: '../a' } } }, 'RELATIVE_REPO'],
  ['conflicting alias models', { agents: { a: { dir: '/a', qwenModel: 'x' }, b: { dir: '/a', qwenModel: 'y' } } }, 'MODEL_CONFLICT'],
]) test(`fleet refuses ${label}`, () => assert.throws(() => planQwenFleet(doc, { resolveDirectory: (p) => p }), code(expected)));

test('launch resumes exact session, defaults to auto and excludes nested agents', () => {
  const spec = qwenLaunchSpec({ executable: '/qwen', cwd: '/repo', resumeSessionId: sid });
  assert.equal(spec.approvalMode, DEFAULT_APPROVAL_MODE); assert.equal(spec.approvalMode, 'auto');
  assert.deepEqual(spec.args.slice(-2), ['--resume', sid]); assert.equal(spec.args.includes('--continue'), false);
  const excluded = spec.args.flatMap((v, i) => v === '--exclude-tools' ? [spec.args[i + 1]] : []);
  assert.deepEqual(excluded, ['agent', 'list_agents']);
  assert.equal(qwenLaunchSpec({ executable: '/qwen', cwd: '/repo', bootstrap: true, approvalMode: 'yolo' }).approvalMode, 'yolo');
});
for (const [label, over, expected] of [
  ['implicit bootstrap', { bootstrap: false }, 'BOOTSTRAP_REQUIRED'],
  ['latest resume', { resumeSessionId: 'latest' }, 'BAD_SESSION'],
  ['unknown approval', { approvalMode: 'magic' }, 'BAD_APPROVAL'],
  ['unbounded tools', { maxToolCalls: 201 }, 'BAD_BUDGET'],
  ['model injection', { model: 'x; rm -rf /' }, 'BAD_MODEL'],
]) test(`launch refuses ${label}`, () => assert.throws(() => qwenLaunchSpec({ executable: '/qwen', cwd: '/repo', bootstrap: true, ...over }), code(expected)));

test('stream preserves denial metadata but never private tool input', () => {
  const r = new QwenTurnReader(); emit(r, start()); emit(r, done({ permission_denials: [{ tool_name: 'run_shell_command', tool_input: { command: 'PRIVATE' } }] }));
  const out = r.finish(0); assert.equal(out.outcome, 'completed_with_denials');
  assert.deepEqual(out.permissionDenials, [{ toolName: 'run_shell_command' }]); assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
});
test('known Qwen nominal-success API error is refused', () => {
  const r = new QwenTurnReader(); emit(r, start()); assert.throws(() => emit(r, done({ result: '[API Error: 401 status code]' })), code('QWEN_API_ERROR'));
});
test('nested Qwen activity is refused even if launcher exclusion regresses', () => {
  const r = new QwenTurnReader(); emit(r, start()); assert.throws(() => emit(r, { type: 'assistant', session_id: sid, parent_tool_use_id: 'nested' }), code('SUBAGENT_UNEXPECTED'));
});
test('wrong-session and incomplete terminal evidence fail closed', () => {
  const wrong = new QwenTurnReader({ expectedSession: other }); assert.throws(() => emit(wrong, start()), code('SESSION_MISMATCH'));
  const incomplete = new QwenTurnReader(); emit(incomplete, start()); assert.throws(() => incomplete.finish(0), code('INCOMPLETE_RESULT'));
});

test('real child stream-json boundary completes without shell/provider', async (t) => {
  const { repo } = await fixture(t); const spec = qwenLaunchSpec({ executable: '/fake/qwen', cwd: repo, bootstrap: true });
  const out = await runQwenProcess(spec, 'hello', { spawnImpl: fakeSpawn(spec) });
  assert.equal(out.sessionId, sid); assert.equal(out.actualModel, 'fixture-model'); assert.equal(out.text, 'fixture:hello');
});
test('real child timeout is terminal and no retry is started', async (t) => {
  const { repo } = await fixture(t); const spec = qwenLaunchSpec({ executable: '/fake/qwen', cwd: repo, bootstrap: true });
  await assert.rejects(runQwenProcess(spec, 'hang-before-handshake', { spawnImpl: fakeSpawn(spec), timeoutMs: 80, killGraceMs: 50 }), code('TIMEOUT'));
});

test('worker persists exact session, resumes it and pins actual model', async (t) => {
  const { worker, stateRoot } = await fixture(t); const specs = [];
  await runQwenWorker(worker, workerOpts(stateRoot, { runProcess: async (spec) => { specs.push(spec); return completed(); } }));
  await runQwenWorker(worker, workerOpts(stateRoot, { requestId: 'r2', bootstrap: false, runProcess: async (spec) => { specs.push(spec); return completed(); } }));
  assert.equal(specs[0].resumeSessionId, null); assert.equal(specs[1].resumeSessionId, sid); assert.equal(specs[1].requestedModel, 'fixture-model');
  const state = JSON.parse(await readFile(join(stateRoot, worker.workerId, 'state.json'), 'utf8'));
  assert.equal(state.version, 2); assert.equal((await lstat(join(stateRoot, worker.workerId, 'state.json'))).mode & 0o077, 0);
});
test('completed request replays once; denial completion also replays without resubmission', async (t) => {
  const { worker, stateRoot } = await fixture(t); let calls = 0;
  const clean = workerOpts(stateRoot, { runProcess: async () => { calls++; return completed(); } });
  await runQwenWorker(worker, clean); assert.equal((await runQwenWorker(worker, clean)).replayed, true); assert.equal(calls, 1);
  const denied = workerOpts(stateRoot, { requestId: 'r2', bootstrap: false, runProcess: async () => { calls++; return completed({ outcome: 'completed_with_denials', permissionDenials: [{ toolName: 'run_shell_command' }] }); } });
  assert.equal((await runQwenWorker(worker, denied)).outcome, 'completed_with_denials'); assert.equal((await runQwenWorker(worker, denied)).replayed, true); assert.equal(calls, 2);
});
test('same request id with changed work conflicts', async (t) => {
  const { worker, stateRoot } = await fixture(t); await runQwenWorker(worker, workerOpts(stateRoot));
  await assert.rejects(runQwenWorker(worker, workerOpts(stateRoot, { prompt: 'different' })), code('REQUEST_CONFLICT'));
});
test('unknown outcome blocks both retry and next request', async (t) => {
  const { worker, stateRoot } = await fixture(t); let calls = 0;
  await assert.rejects(runQwenWorker(worker, workerOpts(stateRoot, { runProcess: async () => { calls++; throw Error('unknown'); } })), code('RUNNER_FAILED'));
  await assert.rejects(runQwenWorker(worker, workerOpts(stateRoot)), code('OUTCOME_UNKNOWN'));
  await assert.rejects(runQwenWorker(worker, workerOpts(stateRoot, { requestId: 'r2' })), code('OUTCOME_UNKNOWN')); assert.equal(calls, 1);
});
test('concurrent second owner is refused before second spawn', async (t) => {
  const { worker, stateRoot } = await fixture(t); let release, begun;
  const ready = new Promise((r) => { begun = r; });
  const first = runQwenWorker(worker, workerOpts(stateRoot, { runProcess: () => { begun(); return new Promise((r) => { release = r; }); } }));
  await ready; await assert.rejects(runQwenWorker(worker, workerOpts(stateRoot, { requestId: 'r2' })), code('WORKER_LOCKED'));
  release(completed()); await first;
});
test('model change underneath owned session is blocked', async (t) => {
  const { worker, stateRoot } = await fixture(t); await runQwenWorker(worker, workerOpts(stateRoot));
  await assert.rejects(runQwenWorker({ ...worker, configuredModel: 'new-model' }, workerOpts(stateRoot, { requestId: 'r2' })), code('MODEL_CHANGE_BLOCKED'));
});

async function cli(args, deps = {}) { let out = '', err = ''; const exit = await main(args, { ...deps, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } }); return { exit, out, err }; }
test('CLI plan is read-only and deduplicates source-config aliases', async (t) => {
  const { root, repo } = await fixture(t); const path = join(root, 'agentmux.yaml'); const text = JSON.stringify({ agents: { a: { dir: repo }, b: { dir: repo } } });
  await writeFile(path, text); const result = await cli(['--plan', '--config', path], { loadYaml: JSON.parse });
  assert.equal(result.exit, 0); const out = JSON.parse(result.out); assert.equal(out.workers.length, 1); assert.equal(out.providerCalls, 0); assert.equal(await readFile(path, 'utf8'), text);
});
test('CLI execution requires explicit provider consent', async (t) => {
  const { root, repo } = await fixture(t); const path = join(root, 'agentmux.json'); await writeFile(path, JSON.stringify({ agents: { a: { dir: repo } } }));
  const result = await cli(['--execute', '--config', path], { loadYaml: JSON.parse }); assert.equal(JSON.parse(result.err).code, 'PROVIDER_CONSENT');
});
test('doctor requires current flags and reports version without prompt', async () => {
  const flags = '--input-format --output-format --approval-mode --resume --max-session-turns --max-tool-calls --max-wall-time --exclude-tools';
  const execFileImpl = (_file, args, opts, cb) => { assert.equal(opts.shell, false); cb(null, args[0] === '--version' ? '0.23.0\n' : flags); };
  const report = await probeQwenExecutable('/qwen', { execFileImpl }); assert.equal(report.compatible, true); assert.equal(report.version, '0.23.0'); assert.equal(report.nestedAgentsDisabled, true);
  const old = await probeQwenExecutable('/qwen', { execFileImpl: (_f, args, _o, cb) => cb(null, args[0] === '--version' ? '0.20.0\n' : '--resume --output-format') });
  assert.equal(old.compatible, false); assert.ok(old.missingFlags.includes('--exclude-tools'));
});
