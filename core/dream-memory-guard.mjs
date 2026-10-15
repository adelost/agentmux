import { dirname, resolve } from "node:path";

/** WHAT: Extracts intact, uniquely dated Dream blocks. WHY: Makes unrelated notes editable without allowing changes to controller-owned evidence. */
export function protectedDreamBlocks(memory) {
  const blocks = [...String(memory).matchAll(/<!-- amux-dream-summary:(\d{4}-\d{2}-\d{2}) -->[\s\S]*?<!-- \/amux-dream-summary:\1 -->/gu)];
  const remainder = blocks.reduce((text, block) => text.replace(block[0], ""), String(memory));
  if (/<!--\s*\/?amux-dream-(?:summary|snapshot):/iu.test(remainder)
      || new Set(blocks.map(block => block[1])).size !== blocks.length) throw new Error("dream-marker");
  return blocks.map(block => block[0]);
}

const values = value => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(values)
    : value && typeof value === "object" ? Object.values(value).flatMap(values) : [];

/** WHAT: Checks whether a curator tool can write memory. WHY: Prevents read results or restored bytes from hiding a curator's memory write. */
export function curatorMemoryWrite(text, memPath) {
  let call;
  try { call = JSON.parse(text); } catch { /* Plain command text from older callers. */ }
  if (call?.tool) {
    const name = call.tool.split(".").at(-1).toLowerCase();
    if (["read", "glob", "grep", "websearch", "webfetch"].includes(name)) return false;
    if (["write", "edit", "multiedit"].includes(name)) {
      const path = call.input?.file_path ?? call.input?.path;
      return !!path && (String(path).startsWith("memory/") || resolve(path).startsWith(`${dirname(resolve(memPath))}/`));
    }
    text = values(call.input).join("\n");
  }
  const memory = String(text).includes(dirname(resolve(memPath))) || /(?:^|[\s/'"=])memory\//u.test(String(text));
  return memory && /(?:\*\*\* (?:Update|Add|Delete) File:|(?:^|\s)(?:tee|cp|mv|rm)\s|\b(?:sed|perl)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rmtree)\s*\(|\bopen\([^\n]*["'][wax][b+]?["']|>>?\s*["']?(?:[^\s"']*memory\/|\$)|\.write\s*\()/u.test(String(text));
}

/** WHAT: Checks only protected content and the curator's write authority. WHY: Keeps unrelated fleet edits separate from Dream evidence and the curator's write restrictions. */
export function judgeDreamMemory(before, current, { ownerTexts = [], memPath } = {}) {
  try {
    if (JSON.stringify(protectedDreamBlocks(before)) !== JSON.stringify(protectedDreamBlocks(current))) {
      return { ok: false, reason: "dream-marker" };
    }
  } catch { return { ok: false, reason: "dream-marker" }; }
  if (memPath && ownerTexts.some(text => curatorMemoryWrite(text, memPath))) return { ok: false, reason: "curator-wrote" };
  return { ok: true };
}
