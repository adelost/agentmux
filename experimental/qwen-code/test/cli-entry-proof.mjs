// Runs the actual AMUX entry file, with isolated collaborators for config/tmux/YAML.
// This is entrypoint proof, not execution of the whole installed AMUX graph.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, rm, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const input = process.argv[2] ?? join(root, 'bin/agent-cli.mjs');
const bytes = await readFile(input);
const scratch = await mkdtemp(join(tmpdir(), 'amux-qwen-entry-'));
async function file(path, text) { const full = join(scratch, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, text); }
let results = [];
try {
  await file('package.json', '{"type":"module"}');
  await file('bin/agent-cli.mjs', bytes);
  await cp(join(root, 'experimental/qwen-code'), join(scratch, 'experimental/qwen-code'), { recursive: true });
  await mkdir(join(scratch, 'repo'));
  const config = JSON.stringify({ agents: { first: { dir: join(scratch, 'repo'), claude: 2 }, alias: { dir: join(scratch, 'repo'), codex: 1 } } });
  await file('source.yaml', config);
  await file('task.txt', 'Offline child fixture, not a provider');
  await file('denied-task.txt', 'permission-denial');
  await file('fake-qwen', '#!/usr/bin/env node\n' + await readFile(join(root, 'experimental/qwen-code/test/fake-qwen.mjs'), 'utf8'));
  await chmod(join(scratch, 'fake-qwen'), 0o700);
  const executionArgs = ['qwen', '--execute', '--allow-provider', '--repo', 'first', '--message-file', join(scratch, 'task.txt'),
    '--request-id', 'cli-task-1', '--executable', join(scratch, 'fake-qwen'), '--state-dir', join(scratch, 'state')];
  await file('node_modules/js-yaml/package.json', '{"type":"module","exports":"./index.js"}');
  await file('node_modules/js-yaml/index.js', 'export const load=JSON.parse;');
  await file('cli/config.mjs', 'export function ensureConfig(){if(process.argv[2]==="qwen")throw Error("QWEN_MUST_NOT_REGENERATE_OR_WRITE");globalThis.calledEnsure=true;}');
  await file('cli/tmux.mjs', 'export function createTmuxContext(){if(process.argv[2]==="qwen")throw Error("QWEN_MUST_NOT_CREATE_TMUX");return {legacyTmux:true};}');
  await file('core/runtime-defaults.mjs', 'export const DEFAULT_TMUX_SOCKET="test";export const runtimeAgentsPath=()=>process.env.TEST_CONFIG;');
  await file('core/runtime-env.mjs', 'export function loadRuntimeEnv(){}');
  await file('core/config-sources.mjs', 'export const resolveConfigSources=()=>({agentmuxYaml:{path:process.env.TEST_CONFIG}});');
  await file('core/runtime-config.mjs', 'export function ensureRuntimeConfig(){if(process.argv[2]==="qwen")throw Error("QWEN_MUST_NOT_SYNC");}');
  await file('cli/command-args.mjs', 'export const isDispatchHelp=argv=>argv.includes("--help")||argv[0]==="help";');
  await file('cli/commands.mjs', 'export const dispatch=(argv,ctx)=>console.log(JSON.stringify({legacy:argv[0],tmux:!!ctx.legacyTmux,ensured:!!globalThis.calledEnsure}));');
  await file('cli/model.mjs', 'export const cmdModel=(argv,ctx)=>console.log(JSON.stringify({model:argv,tmux:!!ctx.legacyTmux}));');
  for (const [id, args, verify] of [
    ['qwen-plan-through-real-entry', ['qwen', '--plan'], (r) => { assert.equal(r.status, 0, r.stderr); const v=JSON.parse(r.stdout);assert.equal(v.mode,'plan-only');assert.equal(v.workers.length,1);assert.equal(v.activeConfigChanged,false); }],
    ['qwen-help-through-real-entry', ['qwen', '--help'], (r) => { assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/bounded AMUX command/); }],
    ['qwen-exec-through-real-entry-and-fake-child', [...executionArgs, '--bootstrap'], (r) => { assert.equal(r.status,0,r.stderr);const v=JSON.parse(r.stdout);assert.equal(v.replayed,false);assert.equal(v.text,'fixture:Offline child fixture, not a provider'); }],
    ['qwen-idempotent-replay-through-real-entry', executionArgs, (r) => { assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).replayed,true); }],
    ['qwen-denied-tool-is-visible-and-nonzero-without-resubmission', ['qwen','--execute','--allow-provider','--repo','first','--message-file',join(scratch,'denied-task.txt'),'--request-id','cli-denied-1','--executable',join(scratch,'fake-qwen'),'--state-dir',join(scratch,'state')], (r) => { assert.equal(r.status,2,r.stderr); const v=JSON.parse(r.stdout); assert.equal(v.outcome,'completed_with_denials'); assert.deepEqual(v.permissionDenials,[{toolName:'run_shell_command'}]); assert.equal(JSON.stringify(v).includes('private command'),false); }],
    ['qwen-doctor-reports-version-and-required-capability', ['qwen','--doctor','--executable',join(scratch,'fake-qwen')], (r) => { assert.equal(r.status,0,r.stderr); const v=JSON.parse(r.stdout); assert.equal(v.version,'0.23.0'); assert.equal(v.compatible,true); assert.equal(v.nestedAgentsDisabled,true); }],
    ['existing-status-dispatch-unchanged', ['status'], (r) => { assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{legacy:'status',tmux:true,ensured:true}); }],
    ['existing-model-dispatch-unchanged', ['model','--example'], (r) => { assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{model:['--example'],tmux:true}); }],
    ['existing-help-no-config-write', ['help'], (r) => { assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{legacy:'help',tmux:false,ensured:false}); }],
  ]) {
    const result = spawnSync(process.execPath, [join(scratch, 'bin/agent-cli.mjs'), ...args], { encoding:'utf8', timeout:8000,
      env:{...process.env,TEST_CONFIG:join(scratch,'source.yaml')} });
    try { verify(result); results.push({id,passed:true}); } catch (e) { results.push({id,passed:false,error:e.message}); }
  }
  assert.equal(await readFile(join(scratch,'source.yaml'),'utf8'),config);
} finally { await rm(scratch,{recursive:true,force:true}); }
console.log(JSON.stringify({sourceGitBlob:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  scope:'Actual CLI entry file; isolated config/tmux modules and JSON-only YAML collaborator. No real AMUX runtime or provider.',results},null,2));
process.exitCode = results.some((r)=>!r.passed)?1:0;
