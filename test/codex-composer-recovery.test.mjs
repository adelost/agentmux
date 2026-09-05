import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent } from '../agent.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(initialComposer, history = '') {
  const root = mkdtempSync(join(tmpdir(), 'amux-composer-recovery-'));
  roots.push(root);
  mkdirSync(join(root, '.agents', '0'), { recursive: true });
  const configPath = join(root, 'agents.yaml');
  writeFileSync(configPath, `probe:\n  dir: ${root}\n  panes:\n    - {cmd: codex}\n`);
  let composer = initialComposer;
  const calls = [];
  const tmuxExec = async (command) => {
    calls.push(command);
    if (command.includes('#{pane_current_command}')) return { stdout: 'node\n' };
    if (command.includes('list-panes')) return { stdout: '0\n' };
    if (command.includes('capture-pane')) return { stdout: `${history}\n› ${composer || 'Ask Codex to do anything'}\n\n  gpt-6-astra xhigh · /tmp/probe` };
    if (command.includes('C-a C-k')) composer = '';
    if (command.includes('send-keys') && command.includes(" -l -- '/compact'")) composer = '/compact';
    if (command.includes('send-keys') && / Enter$/.test(command)) composer = '';
    return { stdout: '0\n' };
  };
  return { calls, agent: createAgent({ tmuxSocket: '/tmp/unused-test.sock', configPath,
    tmuxExec, run: async () => ({ stdout: '' }), delay: async () => {} }) };
}

describe('Codex recovery through the real sendOnly path', () => {
  it('clears an idle AMUX-owned residue and submits compact without a scope error', async () => {
    const { agent, calls } = fixture('[from worker:3] old failed delivery');
    await agent.sendOnly('probe', '/compact', 0);
    expect(calls.some((c) => c.includes('C-a C-k'))).toBe(true);
    expect(calls.some((c) => c.includes(" -l -- '/compact'"))).toBe(true);
    expect(calls.some((c) => / Enter$/.test(c))).toBe(true);
  });

  it('does not mistake an old transcript prompt for a live draft', async () => {
    const { agent, calls } = fixture('', '› [from worker:3] already answered\n• Finished.');
    await agent.sendOnly('probe', '/compact', 0);
    expect(calls.some((c) => c.includes('C-a C-k'))).toBe(false);
    expect(calls.some((c) => c.includes(" -l -- '/compact'"))).toBe(true);
  });

  it('leaves a human draft untouched and blocks the new delivery', async () => {
    const { agent, calls } = fixture('Please keep my unfinished question');
    await expect(agent.sendOnly('probe', '/compact', 0)).rejects.toMatchObject({ code: 'AMUX_DELIVERY_BLOCKED' });
    expect(calls.some((c) => c.includes('C-a C-k'))).toBe(false);
    expect(calls.some((c) => c.includes(" -l -- '/compact'"))).toBe(false);
  });
});
