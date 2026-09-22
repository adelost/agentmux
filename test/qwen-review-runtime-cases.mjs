// Lifecycle scenarios use real runtime code with a controlled tmux collaborator.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const SID = '11111111-1111-4111-8111-111111111111';

/** WHAT: Exercises actual Qwen lifecycle decisions. WHY: Configured continuity must never become a fresh session. */
export function qwenRuntimeCases(createRuntime, reader) {
  function scenario(run) {
    return async () => {
      const root = mkdtempSync(join(tmpdir(), 'amux-qwen-runtime-review-'));
      const paneDir = join(root, 'repo with spaces', '.agents', '4');
      const stateRoot = join(root, 'state'); const commands = [];
      const config = { dir: join(root, 'repo with spaces'), panes: [{}, {}, {}, {}, { model: 'fixture-main' }] };
      const before = process.env.QWEN_CODE_BIN; process.env.QWEN_CODE_BIN = process.execPath;
      const runtime = createRuntime({
        t: {
          runShell: async (_target, command) => {
            commands.push(command);
            const path = /--json-file '([^']+)'/u.exec(command)?.[1];
            const session = /--(?:session-id|resume) '([^']+)'/u.exec(command)?.[1];
            assert.ok(path && session, 'Qwen command must carry event path and exact session');
            writeFileSync(path, JSON.stringify({ type: 'system', subtype: 'session_start', session_id: session,
              data: { cwd: paneDir, protocol_version: 2 } }) + '\n');
          },
          currentCommand: async () => 'node', sendKeys: async () => {}, respawnPane: async () => {},
        },
        wait: async () => {}, paneDir: () => paneDir, agentConfig: () => config,
        isBusy: async () => false, isPaneDead: async () => false, respawnPane: async () => {},
        isAlreadyRunning: async () => false, isShellProcess: () => true,
        captureScreen: async () => '> Type your message or @path/to/file', stateRoot,
      });
      const start = (launch = null) => runtime.startQwen('demo', 'demo:.4', config.dir, 4, launch);
      try { await run({ root, paneDir, stateRoot, config, commands, start }); return true; }
      finally {
        if (before === undefined) delete process.env.QWEN_CODE_BIN; else process.env.QWEN_CODE_BIN = before;
        rmSync(root, { recursive: true, force: true });
      }
    };
  }
  return [
    { id: 'control-bootstrap-then-exact-resume', run: scenario(async ({ commands, start }) => {
      const first = await start(), second = await start();
      assert.equal(first.identity.sessionId, second.identity.sessionId);
      assert.match(commands[0], /--session-id /u); assert.match(commands[1], /--resume /u);
    }) },
    { id: 'configured-resume-is-not-fresh-bootstrap', run: scenario(async ({ config, commands, start }) => {
      config.panes[4].resumeSessionId = SID;
      await start(); assert.match(commands[0], new RegExp(`--resume '${SID}'`, 'u'));
      assert.equal(commands[0].includes('--session-id'), false);
    }) },
    { id: 'corrupt-receipt-cannot-silently-start-fresh', run: scenario(async ({ paneDir, stateRoot, commands, start }) => {
      const files = reader.prepareQwenRuntimeFiles(paneDir, { stateRoot, sessionId: SID, model: 'fixture-main', generation: 'old' });
      writeFileSync(join(files.root, 'runtime.json'), '{incomplete runtime metadata');
      await assert.rejects(start(), /continuity blocked/u); assert.equal(commands.length, 0);
    }) },
    { id: 'working-directory-is-shell-quoted', run: scenario(async ({ commands, start, paneDir }) => {
      await start(); assert.ok(commands[0].startsWith(`cd '${paneDir}' && `));
    }) },
  ];
}
