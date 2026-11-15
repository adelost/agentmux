const MIN_DEPTH = 3;
const MAX_VARIANTS = 64;

// A variable in an rm target: ${NAME}, $NAME, ${N} or a one-digit positional $N.
const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\}|([A-Za-z_][A-Za-z0-9_]*|[0-9]))/gu;

/** WHAT: Resolves an rm target to literal folder prefixes.
 * WHY: Keeps permission paths from guessing about a variable target. */
export function resolveRmTarget(target, command, home) {
  const t = target.replace(/["']/gu, "");
  if (/\$\(|`/u.test(t)) return { why: "rm target comes from command substitution" };
  const names = [...new Set([...t.matchAll(VAR_REF)].map((m) => m[1] ?? m[2]))];
  let combos = [new Map()];
  for (const name of names) {
    const values = variableValues(name, command);
    if (values.why) return values;
    combos = combos.flatMap((combo) => values.words.map((word) => new Map(combo).set(name, word)));
    if (combos.length > MAX_VARIANTS) return { why: `rm target has more than ${MAX_VARIANTS} possible values: ${target}` };
  }
  const paths = [];
  for (const combo of combos) {
    const resolved = literalFolder(t.replace(VAR_REF, (_, braced, bare) => combo.get(braced ?? bare)), command, home, target);
    if (resolved.why) return resolved;
    paths.push(resolved.path);
  }
  return { paths: [...new Set(paths)] };
}

/** The values a variable can have where the rm runs, or why they cannot be known. */
function variableValues(name, command) {
  if (/^[0-9]+$/u.test(name)) return positionalValues(Number(name), command);
  const assignment = new RegExp(`(?:^|[;\\n]|&&|\\|\\|)\\s*${name}=("?)(\\/[^\\s"';&|]+)\\1(?=\\s|;|$)`, "u");
  const assign = assignment.exec(command);
  if (assign) {
    if (/\$/u.test(assign[2])) return { why: `${name} is assigned from another variable` };
    // read off a screen, a path longer than the pane goes on at the next line, and the shorter one is not the path
    // that runs; a path that ends its line may be one of those
    if (command[assign.index + assign[0].length] === "\n") return { why: `${name}'s path ends a screen line and may go on at the next` };
    return { words: [assign[2]] };
  }
  const loop = loopWords(name, command);
  if (loop.why) return loop;
  if (!loop.words) return { why: `${name} is not assigned to a literal absolute path in the same command` };
  if (loop.words.some((w) => /\s/u.test(w))) return { why: `a word the loop gives ${name} holds a space` };
  return loop;
}

/** $N after `set -- $V` where V loops over literal words: the Nth word of each. */
function positionalValues(n, command) {
  if (n === 0) return { why: "$0 is the shell's own name" };
  if (/(?:^|[\s;&|(])shift\b/u.test(command)) return { why: "the command shifts its positional parameters" };
  const words = [];
  let bound = false;
  for (const set of command.matchAll(/(?:^|[\s;&|(])set\s+([^;\n&|]*)/gu)) {
    const args = set[1].trim().split(/\s+/u).filter(Boolean);
    let i = 0;
    // options alone (set -euo pipefail) leave the positionals as they are
    while (i < args.length && /^[-+][A-Za-z]+$/u.test(args[i])) i += /o$/u.test(args[i]) ? 2 : 1;
    if (i >= args.length) continue;
    const from = args[i] === "--" && args.length === i + 2 ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(args[i + 1]) : null;
    if (!from) return { why: `set ${set[1].trim()} does not bind the positionals from a loop's literal words` };
    const loop = loopWords(from[1], command);
    if (loop.why) return loop;
    if (!loop.words) return { why: `$${from[1]} is not a loop over literal words` };
    bound = true;
    for (const item of loop.words) words.push(item.split(/\s+/u).filter(Boolean)[n - 1] ?? "");
  }
  if (!bound) return { why: `$${n} is not set in the command` };
  return { words };
}

/** The words every `for NAME in ...` in the command gives NAME, when each is
 * literal. Returns {} when NAME is no loop variable, { words } or { why }. */
function loopWords(name, command) {
  const starts = [...command.matchAll(new RegExp(`(?:^|[\\s;&|(])for\\s+${name}\\s+in\\s`, "gu"))];
  if (!starts.length) return {};
  if (new RegExp(`(?:^|[\\s;&|(])(?:${name}=|read\\s+(?:-\\S+\\s+)*${name}\\b)`, "u").test(command)) {
    return { why: `${name} is also assigned in the command` };
  }
  const words = [];
  for (const start of starts) {
    let i = start.index + start[0].length;
    for (;;) {
      const token = /^\s*(?:(;|do(?=\s|$))|"([^"$`\\]*)"|'([^']*)'|([^\s;&|<>(){}"'$`\\*?[]+)|(\S))/u.exec(command.slice(i));
      if (!token || token[1] !== undefined) break;
      if (token[5] !== undefined) return { why: `the loop over ${name} has a word that is not literal` };
      const next = command[i + token[0].length];
      if (next !== undefined && !/[\s;]/u.test(next)) return { why: `the loop over ${name} has a word that is not literal` };
      words.push(token[2] ?? token[3] ?? token[4]);
      i += token[0].length;
    }
    // a screen line can break inside a word; with the breaks taken out, no .. may appear
    if (/\.\./u.test(command.slice(start.index, i).replace(/\s+/gu, ""))) return { why: `the loop over ${name} climbs out with ..` };
  }
  return { words };
}

/** A resolved target as the literal folder it removes from. */
function literalFolder(resolved, command, home, target) {
  let t = resolved;
  if (/\$/u.test(t)) return { why: `rm target is still a variable: ${target}` };
  if (t === "~" || t.startsWith("~/")) t = home + t.slice(1);
  const literal = t.split(/[*?[]/u)[0].replace(/\/+$/u, "");
  if (literal.startsWith("/")) return { path: literal };
  // A relative target is only as safe as the folder it runs in.
  const cd = [...command.matchAll(/(?:^|[;\n]|&&)\s*cd\s+("?)(\/[^\s"';&|]+)\1/gu)].at(-1);
  if (!cd) return { why: `relative rm target without a literal cd in the command: ${target}` };
  if (!literal || literal === ".") return { why: "rm target is the whole working directory" };
  return { path: `${cd[2].replace(/\/+$/u, "")}/${literal.replace(/^\.\//u, "")}` };
}

/** WHAT: Checks a resolved removal path. WHY: Keeps root and home-level paths from automatic approval. */
export function unsafeRmPath(path, home) {
  const segments = path.split("/").filter((s) => s && s !== ".");
  if (segments.includes("..")) return `rm target climbs out with ..: ${path}`;
  if (segments.length < MIN_DEPTH) return `${path} is too close to the filesystem root`;
  const homeSegments = String(home || "").split("/").filter(Boolean);
  const underHome = homeSegments.length && homeSegments.every((s, i) => segments[i] === s);
  if (underHome && segments.length <= homeSegments.length + 1) return `${path} is home or a top folder in it`;
  if (segments[0] === "mnt" && segments.length <= 3) return `${path} is a drive or a top folder on it`;
  return null;
}
