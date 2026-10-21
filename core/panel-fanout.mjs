const WINDOW_MS = 15 * 60_000;
const MAX_RECIPIENTS = 4;

/** WHAT: Checks a distinct panel recipient under the existing State lock. WHY: Keeps concurrent CLI sends inside one rolling budget before enqueue. */
export function admitPanelSend({ sender, target, state, fanoutReason = null, source = 'cli', now = Date.now() }) {
  if (fanoutReason !== null && (typeof fanoutReason !== 'string' || !fanoutReason.trim()
      || fanoutReason.length > 1000 || fanoutReason.startsWith('--'))) {
    throw new Error('--fanout requires a non-empty reason (at most 1000 characters)');
  }
  if (!sender || source !== 'cli' || sender === 'lsrc:0' || sender === target) return { exempt: true, override: fanoutReason };
  let result;
  state.updateKey('panelSendFanout', previous => {
    const recent = Object.fromEntries(Object.entries(previous ?? {}).map(([key, rows]) =>
      [key, rows.filter(row => Number.isFinite(row.at) && now - row.at < WINDOW_MS)]).filter(([, rows]) => rows.length));
    const rows = recent[sender] ?? [];
    if (!rows.some(row => row.target === target) && rows.length >= MAX_RECIPIENTS && fanoutReason === null) {
      throw new Error('Panel send refused: at most 4 different recipients in 15 minutes. Contact only a panel that needs an action; use --fanout "reason" for an explicit logged exception.');
    }
    recent[sender] = [...rows.filter(row => row.target !== target), { target, at: now }];
    result = { exempt: false, recipients: recent[sender].length, override: fanoutReason };
    return recent;
  });
  return result;
}
