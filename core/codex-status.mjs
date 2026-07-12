// Native Codex /status parser + fail-closed TUI driver.
//
// /status is the only stable surface that combines effective model/effort,
// account identity, context and the account's rolling usage windows.  The
// driver verifies the exact built-in command row before Enter and then parses
// the box Codex itself rendered; it never infers limits from amux counters.

import { stripAnsi } from "../lib.mjs";
import { prepareCodexIdle } from "./codex-tui.mjs";

const STATUS_HEADER_RE = /OpenAI Codex\s*\(v([^\)]+)\)/i;
const STATUS_PALETTE_ROW = /^\s*\/status\s+show current session configuration and token usage\s*$/im;
const EXACT_STATUS_COMMAND_RE = /^\s*\/status\s*$/;

function cleanBoxLine(line) {
  return stripAnsi(String(line || ""))
    .replace(/^\s*[│╭╰├└┌┬┴─]+\s?/, "")
    .replace(/\s*[│╮╯┤┘┐┬┴─]+\s*$/, "")
    .trimEnd();
}

function parseLimit(value) {
  const clean = String(value || "").replace(/^\[[^\]]*\]\s*/, "").trim();
  const match = clean.match(/(\d+)%\s+left(?:\s+\(resets\s+(.+?)\))?\s*$/i);
  if (!match) return clean ? { raw: clean } : null;
  return { percentLeft: Number(match[1]), resets: match[2] || null, raw: clean };
}

function parseContext(value) {
  const match = String(value || "").trim()
    .match(/(\d+)%\s+left\s+\(([^\)]+?)\s+used\s*\/\s*([^\)]+)\)/i);
  if (!match) return value ? { raw: String(value).trim() } : null;
  return {
    percentLeft: Number(match[1]),
    used: match[2].trim(),
    total: match[3].trim(),
    raw: String(value).trim(),
  };
}

function parseModel(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\S+)(?:\s+\(reasoning\s+([^,\)]+)(?:,\s*summaries\s+([^\)]+))?\))?/i);
  return {
    id: match?.[1] || raw || null,
    effort: match?.[2]?.trim().toLowerCase() || null,
    summaries: match?.[3]?.trim().toLowerCase() || null,
    raw,
  };
}

/** Parse the newest complete OpenAI Codex status box in a pane capture. */
export function parseCodexStatus(text) {
  const lines = String(text || "").split("\n");
  let headerIndex = -1;
  let version = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = cleanBoxLine(lines[index]).match(STATUS_HEADER_RE);
    if (!match) continue;
    headerIndex = index;
    version = match[1].trim();
    break;
  }
  if (headerIndex === -1) return null;

  const status = {
    version,
    usageUrl: null,
    model: null,
    directory: null,
    permissions: null,
    agentsMd: null,
    account: null,
    collaborationMode: null,
    session: null,
    context: null,
    limits: { primary5h: null, weekly: null, spark5h: null, sparkWeekly: null },
    warning: null,
  };
  let spark = false;

  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = cleanBoxLine(lines[index]).trim();
    if (!line) continue;
    if (/^[╰└].*[╯┘]$/.test(stripAnsi(lines[index]).trim())) break;
    const url = line.match(/https:\/\/chatgpt\.com\/codex\/settings\/usage/i)?.[0];
    if (url) status.usageUrl = url;
    if (/^GPT-.*-Spark limit:\s*$/i.test(line)) {
      spark = true;
      continue;
    }

    const pair = line.match(/^([^:]{1,40}):\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].trim().toLowerCase();
    const value = pair[2].trim();
    if (key === "model") status.model = parseModel(value);
    else if (key === "directory") status.directory = value;
    else if (key === "permissions") status.permissions = value;
    else if (key === "agents.md") status.agentsMd = value;
    else if (key === "account") status.account = value;
    else if (key === "collaboration mode") status.collaborationMode = value;
    else if (key === "session") status.session = value;
    else if (key === "context window") status.context = parseContext(value);
    else if (key === "5h limit") {
      if (spark) status.limits.spark5h = parseLimit(value);
      else status.limits.primary5h = parseLimit(value);
    } else if (key === "weekly limit") {
      if (spark) status.limits.sparkWeekly = parseLimit(value);
      else status.limits.weekly = parseLimit(value);
    } else if (key === "warning") status.warning = value;
  }

  // A clipped/narrow capture can contain the header but not the fields.  Do
  // not turn that into a convincing-looking empty status object.
  if (!status.model && !status.account && !status.session) return null;
  return status;
}

function statusMarker(text) {
  const lines = String(text || "").split("\n");
  let lastHeader = -1;
  let lastCommand = -1;
  let commandCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const clean = cleanBoxLine(lines[index]).trim();
    if (STATUS_HEADER_RE.test(clean)) lastHeader = index;
    if (EXACT_STATUS_COMMAND_RE.test(clean)) {
      lastCommand = index;
      commandCount++;
    }
  }
  const status = parseCodexStatus(text);
  return {
    status,
    lastHeader,
    lastCommand,
    commandCount,
    fingerprint: status ? JSON.stringify(status) : null,
  };
}

function formatLimit(label, limit) {
  if (!limit) return null;
  if (!Number.isFinite(limit.percentLeft)) return `${label}: ${limit.raw}`;
  return `${label}: **${limit.percentLeft}% kvar**${limit.resets ? ` · reset ${limit.resets}` : ""}`;
}

export function formatCodexStatus(status, { agentName, pane, profile } = {}) {
  const lines = [`**${agentName}** pane ${pane} · Codex-profil **${profile}** · v${status.version}`];
  if (status.account) lines.push(`Konto: ${status.account}`);
  if (status.model?.id) {
    lines.push(`Modell: **${status.model.id}**${status.model.effort ? ` · reasoning ${status.model.effort}` : ""}`);
  }
  if (status.context) {
    lines.push(Number.isFinite(status.context.percentLeft)
      ? `Context: **${status.context.percentLeft}% kvar** (${status.context.used} / ${status.context.total})`
      : `Context: ${status.context.raw}`);
  }
  const primary = [
    formatLimit("5 h", status.limits.primary5h),
    formatLimit("Vecka", status.limits.weekly),
  ].filter(Boolean);
  if (primary.length) lines.push(primary.join("\n"));
  const spark = [
    formatLimit("Spark 5 h", status.limits.spark5h),
    formatLimit("Spark vecka", status.limits.sparkWeekly),
  ].filter(Boolean);
  if (spark.length) lines.push(spark.join("\n"));
  if (status.warning) lines.push(`⚠️ ${status.warning}`);
  if (status.usageUrl) lines.push(`<${status.usageUrl}>`);
  return lines.join("\n");
}

const fail = (stage, error) => ({ ok: false, stage, error });

/** Drive Codex's built-in /status and return the parsed native status. */
export async function driveCodexStatus({
  agent,
  name,
  pane,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 12_000,
  log = () => {},
} = {}) {
  let zoomChanged = false;
  try {
    if (agent?.zoomPaneForPicker) {
      zoomChanged = await agent.zoomPaneForPicker(name, pane);
      if (zoomChanged) await sleep(300);
    }

    const idle = await prepareCodexIdle({
      agent,
      name,
      pane,
      sleep,
      allowBusy: true,
      requireVisibleComposer: true,
    });
    if (!idle.ok) return idle;

    const beforeCapture = await agent.capturePane(name, pane, 120).catch(() => idle.snapshot || "");
    const beforeMarker = statusMarker(beforeCapture);
    const beforeHistory = agent.paneHistorySize
      ? await agent.paneHistorySize(name, pane).catch(() => null)
      : null;

    await agent.typeLiteral(name, "/status", pane);
    await sleep(650);
    const composed = await agent.capturePane(name, pane, 18).catch(() => "");
    const composerLine = composed.split("\n").reverse()
      .find((line) => /[›❯>]\s*\/\S*status/.test(line));
    const cleanComposer = composerLine && /[›❯>]\s*\/status\s*$/.test(composerLine.trim());
    if (!cleanComposer && !STATUS_PALETTE_ROW.test(composed)) {
      // We own the exact text just inserted. Clear it before dismissing the
      // palette so a failed probe cannot poison the next command with a
      // leftover /status draft.
      await agent.clearInputLine?.(name, pane).catch(() => {});
      await agent.sendEscape(name, pane).catch(() => {});
      return fail("compose", "composer did not show a clean /status command");
    }

    await agent.sendEnter(name, pane);
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      await sleep(500);
      last = await agent.capturePane(name, pane, 120).catch(() => "");
      const marker = statusMarker(last);
      if (!marker.status) continue;
      // A stale box can still sit in scrollback while the freshly-submitted
      // command is waiting for its rate-limit fetch.  The newest exact
      // `/status` line must precede the newest box, and at least one monotonic
      // signal must prove this invocation added output.
      const commandPrecedesBox = marker.lastCommand >= 0 && marker.lastCommand < marker.lastHeader;
      const historyNow = agent.paneHistorySize
        ? await agent.paneHistorySize(name, pane).catch(() => null)
        : null;
      const fresh = marker.commandCount > beforeMarker.commandCount
        || (Number.isFinite(historyNow) && Number.isFinite(beforeHistory) && historyNow > beforeHistory)
        || marker.fingerprint !== beforeMarker.fingerprint;
      if (commandPrecedesBox && fresh) {
        return { ok: true, status: marker.status, wasBusy: idle.busy };
      }
    }
    log(`status: ${name}:${pane} timed out; tail=${last.slice(-160).replace(/\s+/g, " ")}`);
    return fail("parse", "Codex consumed /status but no complete status box appeared");
  } catch (err) {
    return fail("drive", err.message);
  } finally {
    if (agent?.restorePaneZoom) {
      await agent.restorePaneZoom(name, pane, zoomChanged).catch((err) =>
        log(`status: failed to restore pane zoom for ${name}:${pane}: ${err.message}`));
    }
  }
}
