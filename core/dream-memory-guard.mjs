/** WHAT: Extracts intact, uniquely dated Dream blocks. WHY: Makes unrelated notes editable without allowing changes to controller-owned evidence. */
export function protectedDreamBlocks(memory) {
  const blocks = [...String(memory).matchAll(/<!-- amux-dream-summary:(\d{4}-\d{2}-\d{2}) -->[\s\S]*?<!-- \/amux-dream-summary:\1 -->/gu)];
  const remainder = blocks.reduce((text, block) => text.replace(block[0], ""), String(memory));
  if (/<!--\s*\/?amux-dream-(?:summary|snapshot):/iu.test(remainder)
      || new Set(blocks.map(block => block[1])).size !== blocks.length) throw new Error("dream-marker");
  return blocks.map(block => block[0]);
}

/** WHAT: Checks that the daily memory still parses as controller blocks. WHY: Keeps the curator free to write while a corrupted marker still stops an insert into an ambiguous file. */
export function judgeDreamMemory(_before, current) {
  try { protectedDreamBlocks(current); } catch { return { ok: false, reason: "dream-marker" }; }
  return { ok: true };
}
