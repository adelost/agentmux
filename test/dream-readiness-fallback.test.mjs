import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdDream } from '../cli/dream.mjs';

describe('Dream candidate preparation', () => {
  for (const failure of ['start', 'quality', 'compact', 'post-compact-quality', 'response-limit']) {
    it(`uses only the configured fallback after ${failure} failure`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'dream-fallback-'));
      const previousHome = process.env.HOME;
      const previousJanitor = process.env.AMUX_JANITOR_ENABLED;
      process.env.HOME = root;
      process.env.AMUX_JANITOR_ENABLED = 'false';
      const calls = [], notices = [];
      let primaryQualityReads = 0;
      const candidates = [1, 2].map((pane) => ({ agent: 'claw', pane, engine: 'codex', paneDir: `/pane/${pane}` }));
      try {
        const run = () => cmdDream({ configPath: 'unused', agent: {
          ensureReady: async (_a, p) => { if (p === 1 && failure === 'start') throw new Error('startup-unverified'); },
        } }, { workspace: root, quiet: true }, {
          agents: [], runtimeConfig: {}, candidates,
          now: new Date('2026-09-05T02:00:00Z'),
          readReceipts: () => ({ schemaVersion: 1, panes: {} }),
          collectSources: () => ({ sources: [{ agent: 'skyvw', pane: 3, engine: 'codex', turns: 1,
            activityCursor: '2026-09-04T20:00:00Z', latestMs: Date.parse('2026-09-04T20:00:00Z'), filesOmitted: 0,
            entries: [{ timestamp: '2026-09-04T20:00:00Z', userPrompt: 'Fix DSL', items: [{ type: 'text', content: 'Shipped fix.' }] }],
          }], omitted: [], unreadable: [], skipped: [] }),
          getStatus: async () => 'idle',
          getProof: async () => ({ sessionId: 'session-2', ownerTexts: [] }),
          enterSandbox: async (_ctx, _owner, input) => ({ ...input.sandbox, runId: input.runId, inputSha256: input.sha256, sessionId: 'session-2', status: 'running' }),
          finishSandbox: () => {},
          getContext: (dir) => {
            if (dir === '/pane/1') {
              primaryQualityReads++;
              if (failure === 'quality' || (failure === 'post-compact-quality' && primaryQualityReads > 1)) return { model: 'gpt-6-astra' };
            }
            return { model: 'gpt-6-astra', effort: 'xhigh' };
          },
          compactCodex: async ({ pane }) => {
            calls.push(`compact:${pane}`);
            return pane === 1 && failure === 'compact'
              ? { ok: false, reason: 'compact-command-unverified' }
              : { ok: true, sessionId: `session-${pane}`, compactBoundary: true };
          },
          notifyUser: async (text) => notices.push(text),
          mirrorPrompt: async (_ctx, selected) => { calls.push(`mirror:${selected.pane}`); return { channelId: 'visible', messages: 1 }; },
          send: async (_ctx, _a, p) => { calls.push(`send:${p}`); return { delivered: true }; },
          // A curator product opens with the run identity Dream checks before writing memory.
          waitForResult: async ({ owner, outputPath, runId, sourceSha256 }) => {
            if (owner.pane === 1 && failure === 'response-limit') return { ok: false, reason: 'dream-owner-limited' };
            const content = `> Kuraterad av claw:2 efter verifierad kompaktering · run \`${runId}\` · source \`${sourceSha256}\`.\n- A genuine source-backed digest.`;
            writeFileSync(outputPath, content); return { ok: true, content };
          },
          // The daily block links the verified snapshot, which holds the digest (#340).
          recordReceipts: () => {
            calls.push('receipt');
            expect(readFileSync(join(root, 'memory/2026-09-05.md'), 'utf8')).toContain('<!-- amux-dream-snapshot:2026-09-05 ');
            const [snapshot] = readdirSync(join(root, 'memory/dream'));
            expect(readFileSync(join(root, 'memory/dream', snapshot), 'utf8')).toContain('source-backed digest');
          },
        });
        if (failure === 'response-limit') {
          await expect(run()).rejects.toThrow('dream-owner-product-invalid:dream-owner-limited');
          expect(calls.filter(call => call.startsWith('send:'))).toEqual(['send:1']);
          expect(calls).not.toContain('receipt');
          return;
        }
        const result = await run();
        expect(result.owner.pane).toBe(2);
        expect(calls.filter((c) => c.startsWith('send:'))).toEqual(failure === 'response-limit' ? ['send:1', 'send:2'] : ['send:2']);
        if (failure !== 'response-limit') expect(calls).not.toContain('mirror:1');
        else expect(readdirSync(join(root, '.agentmux/dream-input')).filter(name => name.endsWith('.json') && !name.endsWith('.commit.json'))).toHaveLength(2);
        expect(calls.at(-1)).toBe('receipt');
        expect(notices.join(' ')).toContain('claw:1');
        expect(notices.join(' ')).toContain('claw:2');
      } finally {
        process.env.HOME = previousHome;
        if (previousJanitor === undefined) delete process.env.AMUX_JANITOR_ENABLED;
        else process.env.AMUX_JANITOR_ENABLED = previousJanitor;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
