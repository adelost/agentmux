import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent } from '../agent.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function paneRunning(command) {
  const root = mkdtempSync(join(tmpdir(), 'amux-escape-guard-'));
  roots.push(root);
  mkdirSync(join(root, '.agents', '0'), { recursive: true });
  const configPath = join(root, 'agents.yaml');
  writeFileSync(configPath, `probe:\n  dir: ${root}\n  panes:\n    - {cmd: codex}\n`);
  const calls = [];
  const tmuxExec = async (line) => {
    calls.push(line);
    if (line.includes('#{pane_current_command}')) return { stdout: `${command}\n` };
    return { stdout: '0\n' };
  };
  return { calls, agent: createAgent({ tmuxSocket: '/tmp/unused-test.sock', configPath,
    tmuxExec, run: async () => ({ stdout: '' }), delay: async () => {} }) };
}

const escapes = (calls) => calls.filter((line) => line.includes('send-keys') && /Escape/.test(line));

describe('Escape only reaches a running engine', () => {
  it('refuses Escape at a bash prompt, where it would join the next typed command', async () => {
    const { agent, calls } = paneRunning('bash');
    await expect(agent.sendEscape('probe', 0)).rejects.toThrow(/bash prompt/);
    expect(escapes(calls)).toEqual([]);
  });

  it('still sends Escape to a running engine', async () => {
    const { agent, calls } = paneRunning('node');
    await agent.sendEscape('probe', 0);
    expect(escapes(calls)).toHaveLength(1);
  });
});
