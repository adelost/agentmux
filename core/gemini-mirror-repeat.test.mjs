import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeminiTmuxMirror } from './gemini-tmux-mirror.mjs';

test('one submitted turn is not reposted when quota messages accumulate, including after restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gemini-mirror-'));
  try {
    const path = join(home, '.gemini/antigravity-cli');
    mkdirSync(path, { recursive: true });
    const history = (timestamp) => writeFileSync(join(path, 'history.jsonl'), `${JSON.stringify({ workspace: '/repo', display: 'question', timestamp })}\n`);
    history(1);
    const data = new Map(), posts = [];
    const state = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, value) };
    let text = 'Individual quota reached. Resets in 98h.';
    const options = { home, state, agent: { isBusy: async () => false, getResponseStreamWithRaw: async () => ({ items: [{ type: 'text', content: text }] }) }, post: async ({ turn }) => { posts.push(turn); return { ok: true }; } };
    const request = { name: 'demo', idx: 9, dir: '/repo' };
    await createGeminiTmuxMirror(options).poll(request);
    text += '\nIndividual quota reached. Resets in 97h.';
    await createGeminiTmuxMirror(options).poll(request);
    assert.equal(posts.length, 1);
    history(2);
    text = 'A fresh answer';
    await createGeminiTmuxMirror(options).poll(request);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].items[0].content, 'A fresh answer');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
