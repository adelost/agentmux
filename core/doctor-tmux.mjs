// amux doctor: tmux health rules. Session reachability, client attachment,
// pane geometry, and version support, each answering a question that
// otherwise fails invisibly. Pure functions + injected observations so
// every rule is unit-testable; the CLI wrapper does the real reads.

import { OK, WARN, FAIL, check } from "./doctor.mjs";

/** WHAT: Carries the minimum usable tmux pane width. WHY: Keeps doctor and its regression boundary synchronized. */
export const TMUX_MIN_PANE_COLUMNS = 60;
/** WHAT: Carries the minimum usable tmux pane height. WHY: Keeps doctor and its regression boundary synchronized. */
export const TMUX_MIN_PANE_ROWS = 20;

/** WHAT: Checks tmux session reachability for the doctor report. WHY: Keeps unreachable agents from hiding behind a healthy bridge. */
export function checkTmux({ sessions, error, required = true }) {
  if (!required) return check("tmux", OK, "not required by native-only fleet");
  if (error) {
    return check("tmux", FAIL, `health query failed: ${error}`,
      "agents may be unreachable; inspect the amux tmux socket");
  }
  return check("tmux", OK, `${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.join(", ")})`);
}

/** WHAT: Parses one tab-delimited tmux health result. WHY: Rejects partial fields before doctor can report false health. */
function tmuxRows(stdout, fields, label) {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const values = line.split("\t");
    if (values.length !== fields.length) throw new Error(`invalid ${label} observation: ${line}`);
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  });
}

/** WHAT: Fetches tmux session attachments and every pane's geometry. WHY: Prevents the two coupled health rules from observing separate truths. */
export async function observeTmuxFleet(tmux) {
  try {
    const [sessionResult, paneResult] = await Promise.all([
      tmux("list-sessions -F '#{session_name}\t#{session_attached}'"),
      tmux("list-panes -a -F '#{session_name}\t#{pane_index}\t#{pane_width}\t#{pane_height}'"),
    ]);
    const sessions = tmuxRows(sessionResult.stdout, ["name", "attached"], "session")
      .map((session) => ({ ...session, attached: Number(session.attached) }));
    const panes = tmuxRows(paneResult.stdout, ["session", "pane", "width", "height"], "pane")
      .map((pane) => ({
        ...pane,
        pane: Number(pane.pane),
        width: Number(pane.width),
        height: Number(pane.height),
      }));
    if (sessions.some((session) => !Number.isSafeInteger(session.attached) || session.attached < 0)
      || panes.some((pane) => ![pane.pane, pane.width, pane.height].every(Number.isSafeInteger))) {
      throw new Error("tmux returned non-integer health fields");
    }
    return { sessions, panes, error: null };
  } catch (error) {
    return { sessions: [], panes: [], error: String(error.message || error).split("\n")[0] };
  }
}

/** WHAT: Calculates doctor severity for tmux pane geometry. WHY: Prevents unreadable terminal frames from masquerading as operator-ready. */
export function checkTmuxPaneGeometry({ panes = [], error = null, required = true } = {}) {
  if (!required || error) return null;
  const undersized = panes.filter((pane) => pane.width < TMUX_MIN_PANE_COLUMNS
    || pane.height < TMUX_MIN_PANE_ROWS);
  if (!panes.length) {
    return check("tmux pane geometry", FAIL, "no pane geometry observed",
      "attach a client or inspect the amux tmux socket, then rerun amux doctor");
  }
  if (!undersized.length) {
    return check("tmux pane geometry", OK,
      `${panes.length}/${panes.length} panes at least ${TMUX_MIN_PANE_COLUMNS}x${TMUX_MIN_PANE_ROWS}`);
  }
  const detail = undersized.map((pane) => `${pane.session}:${pane.pane} ${pane.width}x${pane.height}`).join(", ");
  return check("tmux pane geometry", FAIL,
    `${undersized.length}/${panes.length} below operator minimum ${TMUX_MIN_PANE_COLUMNS}x${TMUX_MIN_PANE_ROWS}: ${detail}`,
    "attach a client, or run tmux resize-window -t SESSION -x 340 -y 100 on the amux socket");
}

/** WHAT: Calculates doctor severity for tmux client attachment. WHY: Keeps detached-resurrection risk visible even when pane dimensions are currently safe. */
export function checkTmuxClients({ sessions = [], error = null, required = true } = {}) {
  if (!required || error) return null;
  const detached = sessions.filter((session) => session.attached === 0);
  if (!detached.length) return check("tmux clients", OK, `${sessions.length}/${sessions.length} sessions attached`);
  return check("tmux clients", WARN,
    `${detached.length}/${sessions.length} sessions without a client: ${detached.map((session) => session.name).join(", ")}`,
    "attach to the session when using its TUI; headless sessions require a safe tmux default-size");
}

/** WHAT: Checks the installed tmux version against the paste-buffer minimum. WHY: Keeps long prompts from corrupting on tmux older than 3.2 (bracketed-paste framing). */
export function checkTmuxVersion({ version, minimumMajor = 3, minimumMinor = 2, required = true }) {
  if (!required) return check("tmux version", OK, "not required by native-only fleet");
  const label = String(version || "").trim();
  const match = label.match(/(\d+)\.(\d+)/);
  if (!match) {
    return check("tmux version", FAIL, `${label || "unknown"}; need 3.2+ for safe long-prompt paste`,
      "upgrade tmux before starting the bridge");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
  return supported
    ? check("tmux version", OK, `${label.replace(/^tmux\s+/i, "")} (bracketed paste supported)`)
    : check("tmux version", FAIL, `${label.replace(/^tmux\s+/i, "")} is too old; need 3.2+ for safe long-prompt paste`,
        "upgrade tmux before starting the bridge");
}
