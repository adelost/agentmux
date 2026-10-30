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
    text = 'A recovered answer';
    await createGeminiTmuxMirror(options).poll(request);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].items[0].content, 'A recovered answer');
    history(2);
    text = 'A fresh answer';
    await createGeminiTmuxMirror(options).poll(request);
    assert.equal(posts.length, 3);
    assert.equal(posts[2].items[0].content, 'A fresh answer');
    text += '\nIndividual quota reached. Resets in 97h.';
    await createGeminiTmuxMirror(options).poll(request);
    assert.equal(posts.length, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a failed delivery is retried instead of marking the turn sent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gemini-mirror-'));
  try {
    const path = join(home, '.gemini/antigravity-cli');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'history.jsonl'), `${JSON.stringify({ workspace: '/repo', display: 'question', timestamp: 1 })}\n`);
    const data = new Map(); let attempts = 0;
    const state = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, value) };
    const options = { home, state, agent: { isBusy: async () => false, getResponseStreamWithRaw: async () => ({ items: [{ type: 'text', content: 'An answer' }] }) }, post: async () => ({ ok: ++attempts > 1 }) };
    const request = { name: 'demo', idx: 9, dir: '/repo' };
    const mirror = createGeminiTmuxMirror(options);
    await mirror.poll(request); await mirror.poll(request); await mirror.poll(request);
    assert.equal(attempts, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
