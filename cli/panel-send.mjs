import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getAgent, saveLast, validateAgentPane, validateAgentSender } from './config.mjs';
import { truncate } from './format.mjs';
import { sendToPane } from './tmux.mjs';
import { assertConfiguredSender, detectSenderFromEnv, outgoingPaneText } from '../core/sender-detect.mjs';
import { fanoutNotice } from '../core/panel-fanout.mjs';
import { markedPaneText, orderMark, orderNotice, senderLines } from '../core/panel-order.mjs';
import { appendEvent } from '../core/events.mjs';

/** WHAT: Dispatches one CLI send and marks it when it goes outside the order. WHY: Keeps sender policy ahead of the sole durable transport writer, as a warning that never stops a send. */
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
  const who = { session: address?.session ?? null, pane: address?.pane ?? null, target };
  const anyway = Object.hasOwn(flags, 'anyway') ? flags.anyway ?? '' : null;
  const fanoutReason = Object.hasOwn(flags, 'fanout') ? flags.fanout ?? '' : null;
  // Both rules warn and never stop (Mattias 16 Nov 2026, core/panel-order.mjs). Only a flag given without its reason still throws, before anything is recorded.
  const order = orderNotice({ sender, target, text: finalPrompt, guard: readGuard(who), anyway });
  const fanout = fanoutNotice({ sender, target, state: ctx.state, fanoutReason }).notice;
  const stated = [{ event: 'panel_send_order', flag: '--anyway', notice: order, reason: anyway },
    { event: 'panel_send_fanout', flag: '--fanout', notice: fanout, reason: fanoutReason }];
  // Logged before the durable write, so no marked message can exist without its event. A stated reason is logged even when no rule
  // was passed (rule null): `--anyway` is also the builder cap's reason (row 213) and this event is its only record.
  for (const { event, notice, reason } of stated) if (notice || reason !== null) appendEvent({ ts: new Date().toISOString(), event, ...who, reason,
    rule: notice?.rule ?? null, row: notice?.row ?? null, count: notice?.count ?? null, limit: notice?.limit ?? null });
  const outside = stated.filter(entry => entry.notice);
  const paneText = markedPaneText(finalPrompt, outside.map(({ notice, reason }) => orderMark(notice, reason)));
  saveLast(ctx.lastFile, name);
  const res = await sendToPane(ctx, name, pane, paneText, {
    force: !!flags.force, idempotencyKey: idempotencyKey || null, capAnyway: anyway, ...(waitMs != null ? { waitMs } : {}),
  });
  if (res?.blocked || !res?.delivered) { process.exitCode = 1; return; }
  if (res?.unverified) {
    console.error(`Delivery unverified for '${name}' (pane ${pane}); AMUX will not resend automatically.`);
    process.exitCode = 1;
  } else if (!flags.q) console.log(`${res.pending ? 'Queued durably for' : 'Sent to'} '${name}' (pane ${pane}): ${truncate(prompt)}`);
  // The sender is told even under -q: quiet drops the confirmation, never the notice that the send went outside the order.
  const went = res.unverified ? 'Sent unverified' : res.pending ? 'Queued durably' : 'Delivered';
  for (const { notice, reason, flag } of outside) console.log(senderLines(notice, { reason, flag, marked: paneText !== finalPrompt, went }).join('\n'));
}

// A missing guard file is the default and marks nothing. A file that does not parse marks nothing either, and is logged so a broken runner is seen.
function readGuard(who) {
  try {
    const guard = JSON.parse(readFileSync(join(homedir(), '.local/state/fleet-orch/guard.json'), 'utf8'));
    if (!guard || !Number.isFinite(guard.at) || !Array.isArray(guard.pilot) || !Array.isArray(guard.leads)
      || !guard.over || typeof guard.over !== 'object' || !Number.isFinite(guard.limit)) throw new Error('invalid guard');
    return guard;
  } catch (error) {
    if (error.code !== 'ENOENT') appendEvent({ ts: new Date().toISOString(), event: 'panel_send_order_fault', ...who });
    return null;
  }
}
