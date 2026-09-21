// Run explicitly with node --test. These are contract tests, not model-quality tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequest, parseResponse, shadowReport, validateInput, OFFICIAL_ORIGIN, MAX_RESPONSE_BYTES } from './contract.mjs';
import { createJevObserver } from './jev.mjs';
import { main } from './cli.mjs';

const fixtureInput = JSON.parse(await readFile(new URL('./examples/input.json', import.meta.url), 'utf8'));
const fixtureResponse = JSON.parse(await readFile(new URL('./examples/response.json', import.meta.url), 'utf8'));
const input = () => structuredClone(fixtureInput);
const response = () => structuredClone(fixtureResponse);
const jsonResponse = (raw = response(), status = 200) => new Response(JSON.stringify(raw), {
  status, headers: { 'content-type': 'application/json' },
});
const code = (expected) => (error) => error?.code === expected;
const liveConfig = (fetchImpl, extra = {}) => ({ enabled: true, allowDataTransfer: true,
  origin: OFFICIAL_ORIGIN, apiKey: 'test-only-not-a-real-key', fetchImpl, ...extra });
const observer = (fetchImpl = async () => jsonResponse(), extra = {}) => createJevObserver(liveConfig(fetchImpl, extra));
async function cli(args, env = {}) {
  let stdout = '', stderr = '';
  const exit = await main(args, { env, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } });
  return { exit, stdout, stderr };
}
const inputPath = new URL('./examples/input.json', import.meta.url).pathname;

test('default observer is disabled even with a key and never calls fetch', async () => {
  let calls = 0;
  const client = createJevObserver({ apiKey: 'present', fetchImpl: () => { calls++; } });
  assert.deepEqual(await client.observe(input()), { mode: 'disabled', action: 'NO_DISPATCH', attempts: 0 });
  assert.equal(calls, 0);
});

for (const [name, patch, expected] of [
  ['nonboolean enablement', { enabled: 'false' }, 'INVALID_CONFIG'],
  ['missing remote consent', { allowDataTransfer: false }, 'CONSENT_REQUIRED'],
  ['missing explicit origin', { origin: undefined }, 'ORIGIN_REQUIRED'],
  ['lookalike origin', { origin: 'https://api.typesafe.ai.example.com' }, 'ORIGIN_REQUIRED'],
  ['http origin', { origin: 'http://api.typesafe.ai' }, 'ORIGIN_REQUIRED'],
  ['credentials in origin', { origin: 'https://user:password@api.typesafe.ai' }, 'ORIGIN_REQUIRED'],
  ['missing key', { apiKey: '' }, 'KEY_REQUIRED'],
  ['header injection', { apiKey: 'abc\r\nx: y' }, 'KEY_REQUIRED'],
  ['zero budget', { maxCalls: 0 }, 'INVALID_CONFIG'],
  ['unbounded budget', { maxCalls: 6 }, 'INVALID_CONFIG'],
  ['unbounded timeout', { timeoutMs: 30_001 }, 'INVALID_CONFIG'],
]) test(`configuration refuses ${name}`, () => assert.throws(() => observer(undefined, patch), code(expected)));

test('request uses documented schema and excludes local ids/reference ground truth', () => {
  const doc = input(), payload = buildRequest(doc);
  assert.equal(payload.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(payload.questions), ['intent', 'target', 'needs_reasoning']);
  assert.equal(payload.state.message, doc.text);
  assert.equal(payload.questions.target.criteria.t0, doc.targets[0].label);
  assert.equal(payload.questions.needs_reasoning.type, 'noul');
  const text = JSON.stringify(payload);
  assert.equal(text.includes(doc.id), false);
  assert.equal(text.includes('demo:review'), false);
  assert.equal(Object.hasOwn(payload.state, 'reference'), false);
  assert.equal(Object.hasOwn(payload, 'reference'), false);
});

for (const [name, mutate] of [
  ['empty target catalog', (x) => { x.targets = []; }],
  ['blank message', (x) => { x.text = ' '; }],
  ['oversize UTF-8 message', (x) => { x.text = 'ö'.repeat(4097); }],
  ['duplicate targets', (x) => { x.targets[1].id = x.targets[0].id; }],
  ['undeclared selected target', (x) => { x.selectedTarget = 'missing'; }],
  ['secret side field', (x) => { x.apiKey = 'must-not-send'; }],
  ['private target metadata', (x) => { x.targets[0].cwd = '/private'; }],
  ['prototype id', (x) => { x.targets[0].id = '__proto__'; }],
  ['unknown reference label', (x) => { x.reference.intent = 'execute_shell'; }],
  ['too many targets', (x) => { x.targets = Array.from({ length: 33 }, (_, i) => ({ id: `x${i}`, label: 'test' })); }],
]) test(`input refuses ${name}`, () => { const doc = input(); mutate(doc); assert.throws(() => validateInput(doc), code('INVALID_INPUT')); });

test('valid response becomes an observation, never dispatch authority', () => {
  const doc = input(), request = buildRequest(doc), raw = response();
  raw.echo = 'secret prompt echo'; raw.answers.intent.shell = 'rm -rf /';
  const result = shadowReport(doc, request, parseResponse(raw, request), { transport: 'replay' });
  assert.equal(result.action, 'NO_DISPATCH'); assert.equal(result.mode, 'shadow');
  assert.equal(result.observation.target.id, 'demo:review');
  assert.equal(result.comparison.intentMatches, true);
  assert.equal(result.usageBasis, 'replayed fixture, not measured');
  assert.equal(JSON.stringify(result).includes(doc.text), false);
  assert.equal(JSON.stringify(result).includes('secret prompt echo'), false);
  assert.equal(JSON.stringify(result).includes('rm -rf'), false);
});

for (const [name, mutate] of [
  ['wrong pinned model', (x) => { x.model = 'jev-latest'; }],
  ['missing answer', (x) => { delete x.answers.target; }],
  ['additional answer', (x) => { x.answers.execute = {}; }],
  ['invented intent', (x) => { x.answers.intent.choice = 'run_shell'; }],
  ['invented target', (x) => { x.answers.target.choice = 't99'; }],
  ['out-of-range confidence', (x) => { x.answers.target.confidence = 1.1; }],
  ['nonfinite confidence', (x) => { x.answers.intent.confidence = NaN; }],
  ['wrong question type', (x) => { x.answers.needs_reasoning.type = 'score'; }],
  ['bad noul', (x) => { x.answers.needs_reasoning.noul = -0.1; }],
  ['missing probability', (x) => { delete x.answers.intent.probabilities.unknown; }],
  ['non-distribution', (x) => { x.answers.intent.probabilities.agent_message = 0.2; }],
  ['nonwinning choice', (x) => { x.answers.intent.choice = 'computer_action'; }],
  ['missing usage', (x) => { delete x.usage; }],
  ['invalid token count', (x) => { x.usage.input_tokens = '100'; }],
  ['prototype probability key', (x) => { x.answers.target.probabilities = JSON.parse('{"t0":0.9,"t1":0.05,"unknown":0.05,"__proto__":0}'); }],
]) test(`response refuses ${name}`, () => { const raw = response(); mutate(raw); assert.throws(() => parseResponse(raw, buildRequest(input())), code('INVALID_RESPONSE')); });

test('uncertain or conflicting suggestions still never modify selected target', () => {
  const doc = input(), request = buildRequest(doc), raw = response();
  raw.answers.target = { type: 'choice', choice: 't1', confidence: 0.1, probabilities: { t0: 0.3, t1: 0.4, unknown: 0.3 } };
  const result = shadowReport(doc, request, parseResponse(raw, request), { transport: 'replay' });
  assert.equal(result.selectionConflict, true); assert.equal(result.selectedTarget, 'demo:review');
  assert.equal(result.action, 'NO_DISPATCH');
});

test('one fake API request sends correct URL/body and refuses redirects', async () => {
  let request;
  const client = observer(async (url, options) => { request = { url, options }; return jsonResponse(); });
  const out = await client.observe(input());
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer test-only-not-a-real-key');
  assert.deepEqual(JSON.parse(request.options.body), buildRequest(input()));
  assert.equal(out.attempts, 1); assert.equal(out.action, 'NO_DISPATCH');
  assert.equal(JSON.stringify(out).includes('test-only-not-a-real-key'), false);
});

test('call budget is reserved before awaits, including concurrent callers', async () => {
  let calls = 0, finish;
  const client = observer(() => { calls++; return new Promise((r) => { finish = r; }); });
  const first = client.observe(input());
  await assert.rejects(client.observe(input()), code('CALL_LIMIT'));
  finish(jsonResponse()); await first;
  assert.equal(calls, 1); assert.deepEqual(client.stats(), { attempts: 1, remaining: 0 });
});

test('report stays bound to the input snapshot during a delayed response', async () => {
  let finish;
  const doc = input(), client = observer(() => new Promise((r) => { finish = r; }));
  const pending = client.observe(doc);
  doc.targets[0].id = 'wrong:new-target'; doc.selectedTarget = 'wrong:new-target';
  finish(jsonResponse());
  const out = await pending;
  assert.equal(out.observation.target.id, 'demo:review');
  assert.equal(out.selectedTarget, 'demo:review');
});

for (const status of [401, 422, 429, 529]) test(`HTTP ${status} spends one attempt, no retry or provider-body disclosure`, async () => {
  let calls = 0;
  const client = observer(async () => { calls++; return jsonResponse({ error: 'SECRET-TRANSCRIPT' }, status); });
  await assert.rejects(client.observe(input()), (error) => error.code === 'HTTP_ERROR' && !error.message.includes('SECRET'));
  await assert.rejects(client.observe(input()), code('CALL_LIMIT'));
  assert.equal(calls, 1);
});

test('transport error is redacted and never retried', async () => {
  const client = observer(async () => { throw Error('Authorization: Bearer SECRET with transcript'); });
  await assert.rejects(client.observe(input()), (e) => e.code === 'NETWORK_ERROR' && !e.message.includes('SECRET'));
  assert.equal(client.stats().attempts, 1);
});

test('deadline covers a fetch that never settles', async () => {
  const client = observer(() => new Promise(() => {}), { timeoutMs: 15 });
  await assert.rejects(client.observe(input()), code('TIMEOUT'));
  assert.equal(client.stats().attempts, 1);
});

test('deadline covers a response body that stalls, not only the headers', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
  const client = observer(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 15 });
  await assert.rejects(client.observe(input()), code('TIMEOUT'));
});

test('pre-cancelled request performs no API call', async () => {
  let calls = 0; const client = observer(async () => { calls++; return jsonResponse(); });
  const stop = new AbortController(); stop.abort();
  await assert.rejects(client.observe(input(), { signal: stop.signal }), code('ABORTED'));
  assert.equal(calls, 0); assert.equal(client.stats().attempts, 0);
});

test('cancellation after submit spends attempt without retry', async () => {
  const stop = new AbortController(), client = observer(() => new Promise(() => {}));
  const p = client.observe(input(), { signal: stop.signal }); stop.abort();
  await assert.rejects(p, code('ABORTED')); assert.equal(client.stats().attempts, 1);
});

for (const [name, fake, expected] of [
  ['oversize response', () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }), 'RESPONSE_TOO_LARGE'],
  ['HTML body', () => new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }), 'INVALID_RESPONSE'],
  ['malformed JSON', () => new Response('{ secret', { headers: { 'content-type': 'application/json' } }), 'INVALID_RESPONSE'],
]) test(`transport refuses ${name}`, async () => assert.rejects(observer(async () => fake()).observe(input()), code(expected)));

test('CLI help, prepare and synthetic demo never call fetch even with credentials in env', async () => {
  const saved = globalThis.fetch;
  let calls = 0; globalThis.fetch = () => { calls++; throw Error('must not contact network'); };
  try {
    const env = { TYPESAFE_API_KEY: 'test-key', AMUX_JEV_ORIGIN: OFFICIAL_ORIGIN };
    assert.equal((await cli([], env)).exit, 0);
    const prepared = await cli(['--input', inputPath], env);
    assert.equal(JSON.parse(prepared.stdout).networkCalls, 0);
    const demo = await cli(['--demo'], env);
    assert.equal(JSON.parse(demo.stdout).transport, 'synthetic-demo');
    assert.equal(JSON.parse(demo.stdout).action, 'NO_DISPATCH');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = saved; }
});

for (const flags of [
  ['--demo', '--live'], ['--input', inputPath, '--live'],
  ['--input', inputPath, '--allow-remote'], ['--input', inputPath, '--live', '--response', inputPath],
  ['--live', '--allow-remote'], ['--input'], ['--wat'], ['--demo', '--demo'],
]) test(`CLI refuses incomplete/conflicting flags: ${flags.join(' ')}`, async () => {
  const result = await cli(flags);
  assert.equal(result.exit, 1); assert.equal(JSON.parse(result.stderr).action, 'NO_DISPATCH');
});

test('CLI explicit live path can be tested with a fake provider, still no dispatch or raw text output', async () => {
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(); };
  try {
    const result = await cli(['--input', inputPath, '--live', '--allow-remote'], { TYPESAFE_API_KEY: 'test-key', AMUX_JEV_ORIGIN: OFFICIAL_ORIGIN });
    assert.equal(result.exit, 0); assert.equal(calls, 1);
    assert.equal(JSON.parse(result.stdout).action, 'NO_DISPATCH');
    assert.equal(result.stdout.includes(fixtureInput.text), false);
  } finally { globalThis.fetch = saved; }
});

test('CLI bounds local files and reports no file contents on parse errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amux-jev-test-'));
  try {
    const huge = join(dir, 'huge.json'), bad = join(dir, 'bad.json');
    await writeFile(huge, 'x'.repeat(20_000)); await writeFile(bad, 'PRIVATE-CONTENT');
    for (const path of [huge, bad]) {
      const result = await cli(['--input', path]);
      assert.equal(result.exit, 1); assert.equal(result.stderr.includes('PRIVATE-CONTENT'), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime files have no production delivery, pane, voice, execution or SDK dependency imports', async () => {
  for (const file of ['contract.mjs', 'jev.mjs', 'cli.mjs']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(/from\s+['"](?:\.\.\/|.*(?:child_process|delivery|agent-router|voice-input|product-spec|typesafe-ai\/sdk))/.test(text), false);
  }
});
