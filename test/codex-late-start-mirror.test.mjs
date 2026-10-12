import { feature, integration, expect } from 'bdd-vitest';
import { vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonlWatcher } from '../channels/jsonl-watcher.mjs';

feature('Codex output after a cold bridge start reaches its bound Discord channel', () => {
  integration('a missing rollout followed by metadata does not consume the startup reconciliation', {
    given: ['a watcher started before the Codex panel exists', () => {
      const root = mkdtempSync(join(tmpdir(), 'codex-late-mirror-'));
      const oldHome = process.env.HOME;
      process.env.HOME = root;
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T10:22:06Z'));
      const dir = join(root, 'workspace'), paneDir = join(dir, '.agents', '0');
      mkdirSync(paneDir, { recursive: true });
      const day = join(root, '.codex', 'sessions', '2026', '10', '12');
      mkdirSync(day, { recursive: true });
      const file = join(day, 'rollout-late.jsonl'), config = join(root, 'agents.yaml');
      writeFileSync(config, `late:\n  dir: ${dir}\n  panes:\n    - cmd: codex\n  discord:\n    channel: 0\n`);
      const data = {}, posts = [];
      const watcher = createJsonlWatcher({ agentsYamlPath: config,
        state: { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } },
        agent: { getContextPercent: () => null }, discord: { send: async (_channel, payload) => { posts.push(payload); } }, log: () => {} });
      return { root, oldHome, dir, paneDir, file, watcher, posts };
    }],
    when: ['Codex starts late and completes the actual skybar greeting format', async fx => {
      await fx.watcher.checkPane('late', 0, fx.dir);
      writeFileSync(fx.file, JSON.stringify({ type: 'session_meta', payload: { cwd: fx.paneDir, source: 'cli', originator: 'codex-tui' } }) + '\n');
      await fx.watcher.checkPane('late', 0, fx.dir);
      for (const event of [
        { timestamp: '2026-10-12T10:21:58.622Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'greeting' } },
        { timestamp: '2026-10-12T10:21:58.622Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hej' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } },
        { timestamp: '2026-10-12T10:22:05.454Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hej! Vad vill du ta tag i?' }] } },
        { timestamp: '2026-10-12T10:22:05.454Z', type: 'token_usage_record' },
        { timestamp: '2026-10-12T10:22:05.454Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'greeting', last_agent_message: 'Hej! Vad vill du ta tag i?' } },
      ]) appendFileSync(fx.file, JSON.stringify(event) + '\n');
      await fx.watcher.checkPane('late', 0, fx.dir);
      await fx.watcher.checkPane('late', 0, fx.dir);
      return fx.posts;
    }],
    then: ['one exact answer is sent, no silent seed and no duplicate', posts => expect(posts).toEqual(['Hej! Vad vill du ta tag i?'])],
    cleanup: fx => { fx.watcher.stop(); vi.restoreAllMocks(); process.env.HOME = fx.oldHome; rmSync(fx.root, { recursive: true, force: true }); },
  });
});
