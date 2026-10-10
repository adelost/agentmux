// Grows a tmux window to its configured pane count without moving a live pane.
//
// Incident 2026-10-10 (skyvw): a 4-pane window wanted 12. A failed
// list-panes was swallowed into "1 pane", and reconcile split `skyvw:.0`,
// `.1` ... `.7`. tmux inserts a split pane directly after its target, so
// eight new shells took indexes 1-8 and the live agents 1-3 moved to 9-11.
// Every `skyvw:.N` address then named the wrong process, and a delivery to
// the shell at `.2` resumed a Claude session that was still live in `.10`.
//
// Two rules close that class here:
// - a pane count comes from a successful listing, never from a default;
// - a new pane is split only after the current LAST pane, addressed by its
//   stable pane id, and every split is checked against the recorded ids.

/** DTO: Message prefix of every refusal from this module, matched by notice copy. */
export const PANE_LAYOUT_UNSAFE = "pane layout unsafe";

/** WHAT: Names an unknown or shifted pane layout. WHY: Keeps callers from adding or starting panes on a guess. */
export class PaneLayoutError extends Error {
  constructor(message) {
    super(`${PANE_LAYOUT_UNSAFE}: ${message}`);
    this.name = "PaneLayoutError";
    this.code = "AMUX_PANE_LAYOUT_UNSAFE";
  }
}

/** WHAT: Returns a window's pane count or throws. WHY: Keeps a failed listing from posing as a one-pane window. */
export async function countPanes(tmux, session) {
  let count;
  try {
    count = await tmux.paneCount(session);
  } catch (error) {
    throw new PaneLayoutError(`cannot count panes in '${session}' (${error.message}); refusing to add or start panes`);
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new PaneLayoutError(`'${session}' listed ${count} panes; refusing to add or start panes`);
  }
  return count;
}

async function listPanes(tmux, session) {
  try {
    return await tmux.paneRows(session);
  } catch (error) {
    throw new PaneLayoutError(`cannot list panes in '${session}' (${error.message}); refusing to add panes`);
  }
}

/** WHAT: Collects recorded panes whose index changed or vanished. WHY: Keeps a renumbered live pane from going unnoticed. */
export function movedPanes(before, after) {
  const indexById = new Map(after.map((row) => [row.id, row.index]));
  return before
    .filter((row) => indexById.get(row.id) !== row.index)
    .map((row) => ({ id: row.id, from: row.index, to: indexById.get(row.id) ?? null }));
}

const describeMove = ({ id, from, to }) => `${id} ${from}->${to ?? "gone"}`;

// `dirFor(index)` is the cwd for the pane that will land at that index.
// A split that tmux refuses (no space) stops growth and is reported as
// `splitError`; nothing moved, so the caller reports the missing panes.
// A split that moves or removes any recorded pane throws PaneLayoutError
// at once, before another split can make it worse.
/**
 * WHAT: Expands the window after its last pane until it has wantedCount panes.
 * WHY: Keeps a missing-pane repair from shifting the index of a live agent.
 */
export async function appendMissingPanes({ tmux, session, wantedCount, dirFor, afterSplit = async () => {} }) {
  let rows = await listPanes(tmux, session);
  let added = 0;
  while (rows.length < wantedCount) {
    const last = rows.at(-1);
    try {
      await tmux.splitWindowRight(last.id, dirFor(rows.length));
    } catch (error) {
      return { added, rows, splitError: error.message };
    }
    const next = await listPanes(tmux, session);
    const moved = movedPanes(rows, next);
    if (moved.length || next.length !== rows.length + 1) {
      const detail = moved.length
        ? `moved ${moved.map(describeMove).join(", ")}`
        : `expected ${rows.length + 1} panes, found ${next.length}`;
      const error = new PaneLayoutError(
        `'${session}' changed during a split after ${last.id}: ${detail}; stopped after ${added + 1} split(s)`);
      console.error(error.message);
      throw error;
    }
    rows = next;
    added++;
    await afterSplit();
  }
  return { added, rows };
}
