/** WHAT: Extracts intact, uniquely dated Dream blocks. WHY: Makes unrelated notes editable without allowing changes to controller-owned evidence. */
export function protectedDreamBlocks(memory) {
  const blocks = [...String(memory).matchAll(/<!-- amux-dream-summary:(\d{4}-\d{2}-\d{2}) -->[\s\S]*?<!-- \/amux-dream-summary:\1 -->/gu)];
  const remainder = blocks.reduce((text, block) => text.replace(block[0], ""), String(memory));
  if (/<!--\s*\/?amux-dream-(?:summary|snapshot):/iu.test(remainder)
      || new Set(blocks.map(block => block[1])).size !== blocks.length) throw new Error("dream-marker");
  return blocks.map(block => block[0]);
}

/** WHAT: Checks daily-memory effects during curation. WHY: Prevents curator writes regardless of tool syntax; the controller alone writes the day. */
export function judgeDreamMemory(before, current) {
  try {
    if (JSON.stringify(protectedDreamBlocks(before)) !== JSON.stringify(protectedDreamBlocks(current))) return { ok: false, reason: "dream-marker" };
  } catch { return { ok: false, reason: "dream-marker" }; }
  return { ok: true };
}
