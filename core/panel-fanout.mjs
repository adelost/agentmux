const WINDOW_MS = 15 * 60_000;
const MAX_RECIPIENTS = 4;

// A warning, never a stop (Mattias 16 Nov 2026; the delivery pointers are in core/panel-order.mjs): the recipient past the limit is counted and the send goes.
/** WHAT: Stores a distinct panel recipient under the State lock and returns a notice past the limit. WHY: Keeps concurrent CLI sends counted in one rolling window while every send still goes. */
export function fanoutNotice({ sender, target, state, fanoutReason = null, source = 'cli', now = Date.now() }) {
  if (fanoutReason !== null && (typeof fanoutReason !== 'string' || !fanoutReason.trim()
      || fanoutReason.length > 1000 || fanoutReason.startsWith('--'))) {
    throw new Error('--fanout requires a non-empty reason (at most 1000 characters)');
  }
  if (!sender || source !== 'cli' || sender === 'lsrc:0' || sender === target) return { exempt: true, notice: null };
  let result;
  state.updateKey('panelSendFanout', previous => {
    const recent = Object.fromEntries(Object.entries(previous ?? {}).map(([key, rows]) =>
      [key, rows.filter(row => Number.isFinite(row.at) && now - row.at < WINDOW_MS)]).filter(([, rows]) => rows.length));
    const rows = recent[sender] ?? [];
    const past = !rows.some(row => row.target === target) && rows.length >= MAX_RECIPIENTS;
    recent[sender] = [...rows.filter(row => row.target !== target), { target, at: now }];
    const recipients = recent[sender].length, window = `${WINDOW_MS / 60_000} minutes`;
    result = { exempt: false, recipients, notice: !past ? null : { rule: 'fanout', row: null, count: recipients, limit: MAX_RECIPIENTS,
      words: `${recipients} recipients in ${window}, limit ${MAX_RECIPIENTS}`,
      told: `${target} makes ${recipients} different recipients in ${window} (limit ${MAX_RECIPIENTS}). Contact only a panel that needs an action.` } };
    return recent;
  });
  return result;
}
