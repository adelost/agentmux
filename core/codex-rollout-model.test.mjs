import { feature, integration, expect } from 'bdd-vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { readCodexRolloutModel } from './codex-rollout-model.mjs';

feature('Codex launch reads new model evidence without rescanning its rollout', () => {
  integration('repeated wake reads no history and later settings remain authoritative', {
    given: ['a recorded Sol model after tool output', () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'codex-model-scan-'));
      const path = join(root, 'rollout.jsonl');
      const append = event => fs.appendFileSync(path, JSON.stringify(event) + '\n');
      append({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } });
      append({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'xhigh' } });
      return { root, path, append };
    }],
    when: ['reading twice then appending a different actual selection', async fx => {
      await readCodexRolloutModel(fx.path, 'session-a');
      const stream = vi.spyOn(fs, 'createReadStream');
      const read = vi.spyOn(fs, 'readSync');
      syncBuiltinESMExports();
      const same = await readCodexRolloutModel(fx.path, 'session-a');
      const fullStreams = stream.mock.calls.length;
      const readBytes = read.mock.results.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0);
      fx.append({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', reasoning_effort: 'medium' } } });
      const changed = await readCodexRolloutModel(fx.path, 'session-a');
      return { same, changed, fullStreams, readBytes };
    }],
    then: ['the second read is bounded and the appended model is not hidden by the cache', r => {
      expect(r.fullStreams).toBe(0);
      expect(r.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(r.same).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' });
      expect(r.changed).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' });
    }],
    cleanup: fx => { vi.restoreAllMocks(); syncBuiltinESMExports(); fs.rmSync(fx.root, { recursive: true, force: true }); },
  });
});
