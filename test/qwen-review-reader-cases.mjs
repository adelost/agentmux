// Shared regression scenarios, exercised against the real reader and filesystem.
// No provider, Qwen process, tmux server, or user-owned state is used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync,
  rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const row = (value) => `${JSON.stringify(value)}\n`;
const user = (text, session = A, extra = {}) => ({ type: 'user', session_id: session,
  message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const assistant = (text, session = A, extra = {}) => ({ type: 'assistant', session_id: session,
  model: 'fixture-main', message: { role: 'assistant', content: [{ type: 'text', text }],
    usage: { total_tokens: 100 } }, ...extra });

/** WHAT: Defines reproducible reader contracts. WHY: Fixtures must not need the operator's live account or sessions. */
export function qwenReaderCases(reader) {
  function scenario(run) {
    return async () => {
      const root = mkdtempSync(join(tmpdir(), 'amux-qwen-regression-'));
      const pane = join(root, 'pane');
      const options = { stateRoot: join(root, 'state'), qwenHome: join(root, 'qwen') };
      const create = (generation, sessionId = A) => {
        const files = reader.prepareQwenRuntimeFiles(pane, { ...options, sessionId,
          model: 'fixture-main', generation });
        writeFileSync(files.eventsPath, row({ type: 'system', subtype: 'session_start',
          session_id: sessionId, data: { cwd: pane, protocol_version: 2 } }));
        reader.publishQwenRuntime(files);
        return files;
      };
      const chat = (sessionId = A) => {
        const dir = join(options.qwenHome, 'projects', 'fixture', 'chats');
        mkdirSync(dir, { recursive: true });
        return join(dir, `${sessionId}.jsonl`);
      };
      try { await run({ root, pane, options, create, chat }); return true; }
      finally { rmSync(root, { recursive: true, force: true }); }
    };
  }
  return [
    { id: 'control-current-intake-and-answer', run: scenario(({ pane, options, create }) => {
      const f = create('current');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'hello', options);
      appendFileSync(f.eventsPath, row(user('hello')) + row(assistant('answer')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'hello', { ...options, cursor }), true);
      assert.equal(reader.isBusyFromQwenJsonl(pane, options), false);
      assert.equal(reader.extractFromQwenJsonl(pane, 'hello', options).raw, 'answer');
    }) },
    { id: 'control-identical-prompt-needs-new-append', run: scenario(({ pane, options, create }) => {
      const f = create('repeat'); appendFileSync(f.eventsPath, row(user('repeat')) + row(assistant('old')));
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'repeat', options);
      assert.equal(reader.isPromptInQwenJsonl(pane, 'repeat', { ...options, cursor }), false);
      appendFileSync(f.eventsPath, row(user('repeat')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'repeat', { ...options, cursor }), true);
    }) },
    { id: 'late-old-generation-cannot-finish-current-turn', run: scenario(({ pane, options, create }) => {
      const old = create('old'), current = create('current');
      appendFileSync(current.eventsPath, row(user('current task')));
      appendFileSync(old.eventsPath, row(user('old task')) + row(assistant('old answer')));
      utimesSync(old.eventsPath, new Date('2030-01-01'), new Date('2030-01-01'));
      assert.equal(reader.isBusyFromQwenJsonl(pane, options), true);
      assert.equal(reader.extractFromQwenJsonl(pane, 'old task', options), null);
    }) },
    { id: 'late-old-generation-cannot-ack-current-prompt', run: scenario(({ pane, options, create }) => {
      const old = create('old'); create('current');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'same text', options);
      appendFileSync(old.eventsPath, row(user('same text')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'same text', { ...options, cursor }), false);
    }) },
    { id: 'foreign-session-cannot-ack-current-prompt', run: scenario(({ pane, options, create }) => {
      const f = create('current');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'same text', options);
      appendFileSync(f.eventsPath, row(user('same text', B)));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'same text', { ...options, cursor }), false);
    }) },
    { id: 'subagent-cannot-ack-root-delivery', run: scenario(({ pane, options, create }) => {
      const f = create('current');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'same text', options);
      appendFileSync(f.eventsPath, row(user('same text', A, { parent_tool_use_id: 'child-1' })));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'same text', { ...options, cursor }), false);
    }) },
    { id: 'subagent-cannot-finish-root-or-replace-model', run: scenario(({ pane, options, create }) => {
      const f = create('current');
      const tool = assistant('', A);
      tool.message.content = [{ type: 'tool_use', id: 'parent-tool', name: 'agent', input: { description: 'explore' } }];
      appendFileSync(f.eventsPath, row(user('root task')) + row(tool));
      appendFileSync(f.eventsPath, row(assistant('child finished', A,
        { parent_tool_use_id: 'parent-tool', model: 'fixture-fast' })));
      assert.equal(reader.isBusyFromQwenJsonl(pane, options), true);
      assert.equal(reader.getContextFromQwenJsonl(pane, options).model, 'fixture-main');
      assert.equal(reader.extractFromQwenJsonl(pane, 'root task', options).raw.includes('child finished'), false);
    }) },
    { id: 'foreign-session-cannot-finish-root', run: scenario(({ pane, options, create }) => {
      const f = create('current');
      appendFileSync(f.eventsPath, row(user('root task')) + row(assistant('foreign answer', B)));
      assert.equal(reader.isBusyFromQwenJsonl(pane, options), true);
    }) },
    { id: 'sidecar-over-16MiB-retains-latest-turn', run: scenario(({ pane, options, create }) => {
      const f = create('large');
      appendFileSync(f.eventsPath, row({ type: 'diagnostic', padding: 'x'.repeat(16 * 1024 * 1024) }));
      appendFileSync(f.eventsPath, row(user('latest')) + row(assistant('large-sidecar-ok')));
      assert.equal(reader.extractFromQwenJsonl(pane, 'latest', options)?.raw, 'large-sidecar-ok');
      assert.equal(reader.isBusyFromQwenJsonl(pane, options), false);
    }) },
    { id: 'chat-over-16MiB-retains-latest-turn', run: scenario(({ pane, options, create, chat }) => {
      create('large'); const path = chat();
      writeFileSync(path, row({ type: 'diagnostic', padding: 'x'.repeat(16 * 1024 * 1024) }));
      appendFileSync(path, row({ type: 'user', sessionId: A, timestamp: '2026-09-22T04:00:00Z',
        message: { role: 'user', parts: [{ text: 'latest' }] } }) +
        row({ type: 'assistant', sessionId: A, model: 'fixture-main', timestamp: '2026-09-22T04:00:01Z',
          message: { role: 'model', parts: [{ text: 'large-chat-ok' }] } }));
      assert.equal(reader.readLastTurnsQwen(pane, options)?.turns.at(-1).items[0].content, 'large-chat-ok');
    }) },
    { id: 'native-text-blocks-have-distinct-stable-ids', run: scenario(({ pane, options, create, chat }) => {
      create('blocks'); const path = chat();
      writeFileSync(path, row({ type: 'user', sessionId: A, message: { role: 'user', parts: [{ text: 'task' }] } }) +
        row({ type: 'assistant', sessionId: A, message: { role: 'model', parts: [{ text: 'first' }, { text: 'second' }] } }));
      const items = reader.readLastTurnsQwen(pane, options).turns[0].items;
      assert.equal(new Set(items.map((item) => item.id)).size, 2);
      appendFileSync(path, row({ type: 'system', note: 'irrelevant' }));
      assert.deepEqual(reader.readLastTurnsQwen(pane, options).turns[0].items.map((i) => i.id), items.map((i) => i.id));
    }) },
    { id: 'metadata-cannot-redirect-prompt-to-unrelated-file', run: scenario(async ({ root, pane, options, create }) => {
      const f = create('bound'); const other = join(root, 'unrelated.txt'); writeFileSync(other, 'KEEP');
      const path = join(f.root, 'runtime.json');
      const metadata = JSON.parse(readFileSync(path, 'utf8')); metadata.inputPath = other;
      writeFileSync(path, JSON.stringify(metadata));
      await assert.rejects(reader.submitQwenPrompt(pane, 'must not go there', options));
      assert.equal(readFileSync(other, 'utf8'), 'KEEP');
    }) },
    { id: 'captured-receipt-survives-a-later-restart', run: scenario(({ pane, options, create }) => {
      const old = create('old');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'pending', options);
      create('replacement');
      appendFileSync(old.eventsPath, row(user('pending')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'pending', { ...options, cursor }), true);
    }) },
    { id: 'replacement-cannot-ack-an-older-delivery', run: scenario(({ pane, options, create }) => {
      create('old'); const cursor = reader.captureQwenPromptEchoCursor(pane, 'pending', options);
      const next = create('replacement'); appendFileSync(next.eventsPath, row(user('pending')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'pending', { ...options, cursor }), false);
    }) },
    { id: 'legacy-byte-cursor-still-works-for-captured-file', run: scenario(({ pane, options, create }) => {
      const f = create('old-cursor');
      const cursor = reader.captureQwenPromptEchoCursor(pane, 'legacy', options);
      delete cursor.sessionId; delete cursor.generation;
      appendFileSync(f.eventsPath, row(user('legacy')));
      assert.equal(reader.isPromptInQwenJsonl(pane, 'legacy', { ...options, cursor }), true);
    }) },
    { id: 'native-history-survives-process-generation-change', run: scenario(({ pane, options, create, chat }) => {
      create('old'); const path = chat();
      writeFileSync(path, row({ type: 'user', sessionId: A, message: { role: 'user', parts: [{ text: 'old task' }] } }) +
        row({ type: 'assistant', sessionId: A, message: { role: 'model', parts: [{ text: 'old answer' }] } }));
      create('replacement');
      assert.equal(reader.readLastTurnsQwen(pane, options).turns[0].items[0].content, 'old answer');
    }) },
    { id: 'native-thoughts-stay-private', run: scenario(({ pane, options, create, chat }) => {
      create('privacy'); writeFileSync(chat(), row({ type: 'user', sessionId: A,
        message: { role: 'user', parts: [{ text: 'task' }] } }) + row({ type: 'assistant', sessionId: A,
        message: { role: 'model', parts: [{ text: 'PRIVATE', thought: true }, { text: 'PUBLIC' }] } }));
      const out = reader.readLastTurnsQwen(pane, options);
      assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
      assert.equal(out.turns[0].items[0].content, 'PUBLIC');
    }) },
    { id: 'bounded-tail-reports-truncation-and-keeps-utf8', run: scenario(({ pane, options, create, chat }) => {
      create('tail'); const path = chat();
      writeFileSync(path, row({ type: 'diagnostic', padding: 'å'.repeat(2000) }) +
        row({ type: 'user', sessionId: A, message: { role: 'user', parts: [{ text: 'senaste' }] } }) +
        row({ type: 'assistant', sessionId: A, message: { role: 'model', parts: [{ text: 'svar åäö' }] } }));
      const out = reader.readLastTurnsQwen(pane, { ...options, tailBytes: 1024 });
      assert.equal(out.truncated, true); assert.equal(out.turns[0].items[0].content, 'svar åäö');
    }) },
    { id: 'large-file-does-not-hide-start-handshake-at-publication', run: scenario(({ create }) => {
      const f = create('big-ready');
      appendFileSync(f.eventsPath, row({ type: 'diagnostic', padding: 'x'.repeat(16 * 1024 * 1024) }));
      assert.equal(reader.publishQwenRuntime(f).sessionId, A);
    }) },
  ];
}
