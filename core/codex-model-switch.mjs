const COMPACT_ERROR = /error running remote compact task|access token could not be refreshed|usage limit/i;

const compactTime = (context) => {
  const value = Date.parse(String(context?.lastCompactAt || ""));
  return Number.isFinite(value) ? value : null;
};

const newerCompactReceipt = (before, after) => {
  const previous = compactTime(before);
  const current = compactTime(after);
  return current != null && (previous == null || current > previous);
};

/** WHAT: Resolves compact-first ordering for one Codex model switch. WHY: Prevents avoidable cache misses after idle periods. */
export async function compactThenSwitchCodex({
  readContext,
  readOutput,
  sendCompact,
  compact = null,
  switchModel,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 60_000,
  pollMs = 1_000,
}) {
  const [beforeContext, beforeOutput] = await Promise.all([readContext(), readOutput()]);
  if (compact) {
    const receipt = await compact();
    if (!receipt?.ok) return { ok: false, stage: "compact", reason: receipt?.reason || "missing-receipt" };
    const switched = await switchModel({ beforeContext, afterContext: await readContext(), compactReceipt: receipt });
    return switched?.ok === false ? switched : { ok: true, ...switched, compactReceipt: receipt };
  }
  const sent = await sendCompact();
  if (!sent?.delivered || sent.pending) {
    return { ok: false, stage: "delivery", reason: sent?.reason || "compact-not-acknowledged" };
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await wait(pollMs);
    const [afterContext, afterOutput] = await Promise.all([readContext(), readOutput()]);
    if (newerCompactReceipt(beforeContext, afterContext)) {
      const switched = await switchModel({ beforeContext, afterContext });
      return switched?.ok === false
        ? switched
        : { ok: true, ...switched, compactedAt: afterContext.lastCompactAt };
    }
    if (afterOutput !== beforeOutput && COMPACT_ERROR.test(String(afterOutput || ""))) {
      return { ok: false, stage: "compact", reason: "remote-error" };
    }
  }
  return { ok: false, stage: "compact", reason: "receipt-timeout" };
}
