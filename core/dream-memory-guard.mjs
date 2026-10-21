import { dirname, resolve } from "node:path";
import { dreamScriptTools, shellOperators } from "./dream-script-tools.mjs";

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

const memoryTarget = (path, memPath) => !!path && (/\.(?:curator\.md|memory-repair\.json)$/u.test(String(path)) || String(path).toLowerCase().split(/[\\/]/u)
  .some(part => ["memory", "memory.md"].includes(part)) || resolve(path).startsWith(`${dirname(resolve(memPath))}/`));

// Resolve only a single literal binding before the redirect. Dynamic or rebound variables remain unknown.
function redirectTarget(command, path, at) {
  const ref = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(?=\/|$)/u.exec(path || "");
  if (!ref) return path;
  const prefix = command.slice(0, at), name = ref[1] || ref[2];
  if (/\b(?:eval|source|read|unset|declare|local|typeset)\b|(?:^|[;&|])\s*\.\s|`|\$\(/u.test(prefix)) return path;
  const operators = shellOperators(prefix);
  const bindings = [...operators.matchAll(new RegExp(`\\b${name}=(?!=)`, "gu"))];
  if (bindings.length !== 1) return path;
  const declaration = new RegExp(`(?:^|&&|;|\\n)\\s*${name}=`, "u").exec(operators);
  if (!declaration) return path;
  const value = prefix.slice(declaration.index + declaration[0].length).match(/^(\/[A-Za-z0-9_./-]+)\s*&&/u)?.[1];
  if (!value || new RegExp(`\\b(?:for|select)\\s+${name}\\b|\\b${name}(?:\\+\\+|--|\\s*[+\\-]=)`, "u").test(prefix)) return path;
  const suffix = path.slice(ref[0].length);
  return /^\/[A-Za-z0-9_./-]*$/u.test(suffix) || !suffix ? value + suffix : path;
}

/** WHAT: Checks whether a curator tool can write memory. WHY: Prevents read results or restored bytes from hiding a curator's memory write. */
export function curatorMemoryWrite(text, memPath) {
  let call;
  try { call = JSON.parse(text); } catch { /* Plain command text from older callers. */ }
  if (call?.tool) {
    const name = call.tool.split(".").at(-1).toLowerCase();
    if (["read", "glob", "grep", "websearch", "webfetch"].includes(name)) return false;
    if (["write", "edit", "multiedit"].includes(name)) {
      return memoryTarget(call.input?.file_path ?? call.input?.path, memPath);
    }
    if (name === "apply_patch") {
      return [...String(call.input).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu)]
        .some(match => memoryTarget(match[1] ?? match[2], memPath));
    }
    if (name === "exec" && typeof call.input === "string") {
      return dreamScriptTools(call.input).some(nested => curatorMemoryWrite(JSON.stringify(nested), memPath))
        || /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rmtree)\s*\(/u.test(call.input)
          && /(?:memory\/|MEMORY\.md)/u.test(call.input);
    }
    if (call.input?.workdir && memoryTarget(call.input.workdir, memPath)) text = `cd ${JSON.stringify(call.input.workdir)} && ${call.input.cmd ?? call.input.command ?? ""}`;
    else text = values(call.input).join("\n");
  }
  const inMemory = /\bcd\s+["']?(?:[^\s"';&|]*\/)?memory(?:\/[^\s"';&|]*)?["']?\s*(?:&&|;|\n)/iu.test(String(text));
  const redirects = [...shellOperators(String(text)).matchAll(/(?<!=)>{1,2}(?:\|)?/gu)];
  if (redirects.some(match => {
    const target = String(text).slice(match.index + match[0].length).trimStart().match(/^(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u);
    const path = redirectTarget(String(text), target?.[1] ?? target?.[2] ?? target?.[3], match.index);
    return path && (memoryTarget(path, memPath) || inMemory && !path.startsWith("/") && !path.startsWith("&"));
  })) return true;
  const memory = inMemory || String(text).includes(dirname(resolve(memPath))) || /(?:^|[\s/'"=])memory\/|\.(?:curator\.md|memory-repair\.json)/u.test(String(text));
  return memory && /(?:\*\*\* (?:Update|Add|Delete) File:|(?:^|\s)(?:tee|cp|mv|rm)\s|\b(?:sed|perl)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*i|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rmtree)\s*\(|\bopen\([^\n]*["'][wax][b+]?["']|\.write\s*\()/u.test(String(text));
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
