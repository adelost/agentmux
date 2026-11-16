import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getAgent, saveLast, validateAgentPane, validateAgentSender } from './config.mjs';
import { truncate } from './format.mjs';
import { sendToPane } from './tmux.mjs';
import { assertConfiguredSender, detectSenderFromEnv, outgoingPaneText } from '../core/sender-detect.mjs';
import { admitPanelSend } from '../core/panel-fanout.mjs';
import { orderRefusal } from '../core/panel-order.mjs';
import { appendEvent } from '../core/events.mjs';

/** WHAT: Checks and admits one CLI send. WHY: Keeps sender policy ahead of the existing sole durable transport writer. */
export async function cmdSend(name, prompt, flags, ctx) {
  const pane = flags.p || 0;
  validateAgentPane(ctx.configPath, name, pane);
  const sender = detectSenderFromEnv(process.env, cmd => execSync(cmd, { encoding: 'utf8', timeout: 2000 }));
  const address = assertConfiguredSender(sender, (session, senderPane) => validateAgentSender(ctx.configPath, session, senderPane));
  const finalPrompt = outgoingPaneText(prompt, sender);
  const paneCmd = getAgent(ctx.configPath, name).panes?.[pane]?.cmd || '';
  if (/^\/model(?:\s|$)/u.test(finalPrompt) && /\bclaude\b/u.test(paneCmd)) {
    throw new Error(`Raw Claude /model bypasses compact: use amux model ${name} -p ${pane} MODEL`);
  }
  const idempotencyKey = flags['idempotency-key'];
  if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || Buffer.byteLength(idempotencyKey, 'utf8') > 256
      || !/^[a-zA-Z0-9:._/-]+$/u.test(idempotencyKey))) throw new Error('--idempotency-key must be 1-256 safe identity characters');
  const waitMs = flags['wait-ms'];
  if (waitMs != null && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 12_000)) throw new Error('--wait-ms must be 0-12000');
  const target = `${name}:${pane}`;
  const anyway = Object.hasOwn(flags, 'anyway') ? flags.anyway ?? '' : null;
  let guard = null;
  try {
    guard = JSON.parse(readFileSync(join(homedir(), '.local/state/fleet-orch/guard.json'), 'utf8'));
    if (!guard || !Number.isFinite(guard.at) || !Array.isArray(guard.pilot) || !Array.isArray(guard.leads)
      || !guard.over || typeof guard.over !== 'object' || !Number.isFinite(guard.limit)) throw new Error('invalid guard');
  } catch (error) {
    guard = null;
    if (error.code !== 'ENOENT') appendEvent({ ts: new Date().toISOString(), event: 'panel_send_order_fault',
      session: address?.session ?? null, pane: address?.pane ?? null, target });
  }
  const refusal = orderRefusal({ sender, target, text: finalPrompt, guard, anyway });
  if (refusal) throw new Error(refusal);
  if (anyway !== null) appendEvent({ ts: new Date().toISOString(), event: 'panel_send_order',
    session: address?.session ?? null, pane: address?.pane ?? null, target, reason: anyway });
  const fanoutReason = Object.hasOwn(flags, 'fanout') ? flags.fanout ?? '' : null;
  const admission = admitPanelSend({ sender, target: `${name}:${pane}`, state: ctx.state, fanoutReason });
  if (admission.override !== null) appendEvent({ ts: new Date().toISOString(), event: 'panel_send_fanout',
    session: address?.session ?? null, pane: address?.pane ?? null, target: `${name}:${pane}`, reason: admission.override });
  saveLast(ctx.lastFile, name);
  const res = await sendToPane(ctx, name, pane, finalPrompt, {
    force: !!flags.force, idempotencyKey: idempotencyKey || null, ...(waitMs != null ? { waitMs } : {}),
  });
  if (res?.blocked || !res?.delivered) { process.exitCode = 1; return; }
  if (res?.unverified) {
    console.error(`Delivery unverified for '${name}' (pane ${pane}); AMUX will not resend automatically.`);
    process.exitCode = 1; return;
  }
  if (!flags.q) console.log(`${res.pending ? 'Queued durably for' : 'Sent to'} '${name}' (pane ${pane}): ${truncate(prompt)}`);
}
