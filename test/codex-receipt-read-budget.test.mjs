import { feature, integration, expect } from 'bdd-vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureCodexPromptEchoCursor, isPromptInCodexJsonl } from '../core/codex-jsonl-reader.mjs';

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'codex-receipt-budget-'));
  const home = process.env.HOME;
  process.env.HOME = root;
  const dir = join(root, 'pane'), day = join(root, '.codex', 'sessions', '2026', '10', '12');
  fs.mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-test.jsonl');
  const append = event => fs.appendFileSync(file, JSON.stringify(event) + '\n');
  append({ type: 'session_meta', payload: { cwd: dir, source: 'cli', originator: 'codex-tui' } });
  const cursor = captureCodexPromptEchoCursor(dir, 'hej åäö');
  append({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) } });
  return { root, home, dir, file, cursor, append };
}

feature('Codex receipt polling does not repeatedly scan unchanged history', () => {
  integration('an absent receipt costs no rollout body reread, and a later exact input remains visible', {
    given: ['an exact submit cursor followed by irrelevant tool output', fixture],
    when: ['polling twice, then appending the current user.text encoding', fx => {
      expect(isPromptInCodexJsonl(fx.dir, 'hej åäö', { cursor: fx.cursor })).toBe(false);
      let bytes = 0;
      const read = fs.readSync;
      vi.spyOn(fs, 'readSync').mockImplementation((...args) => { const count = read(...args); bytes += count; return count; });
      syncBuiltinESMExports();
      const repeated = isPromptInCodexJsonl(fx.dir, 'hej åäö', { cursor: fx.cursor });
      const repeatBytes = bytes;
      fx.append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hej åäö' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
      const received = isPromptInCodexJsonl(fx.dir, 'hej åäö', { cursor: fx.cursor });
      const next = captureCodexPromptEchoCursor(fx.dir, 'hej åäö');
      const repeatedInput = isPromptInCodexJsonl(fx.dir, 'hej åäö', { cursor: next });
      return { repeated, repeatBytes, received, repeatedInput };
    }],
    then: ['unchanged polling is bounded, while new and repeated inputs retain exact receipt semantics', r => {
      expect(r.repeated).toBe(false);
      expect(r.repeatBytes).toBeLessThanOrEqual(64 * 1024);
      expect(r.received).toBe(true);
      expect(r.repeatedInput).toBe(false);
    }],
    cleanup: fx => { vi.restoreAllMocks(); syncBuiltinESMExports(); process.env.HOME = fx.home; fs.rmSync(fx.root, { recursive: true, force: true }); },
  });
});
