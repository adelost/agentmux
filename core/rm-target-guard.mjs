// rm targets that Claude Code stops for a person, found before the call runs.
//
// Mattias 2026-09-29, after lsrc:1 waited 6 minutes on "Dangerous rm operation on
// possibly-empty variable path: $S/$2": "jag tycker inte den ska pausa". Claude
// Code 2.1.284 asks a person about such a removal even in bypass mode, and only a
// person may answer it: an unanswered ask times out after two minutes, and after
// three in a session it refuses without asking. Refusing the call here, with the
// form the check accepts, turns a stopped pane into one quick retry.

import { resolveRmTarget, unsafeRmPath } from "./rm-target-resolution.mjs";

// Claude Code 2.1.284's own tests for a target whose root is a variable, so that an
// empty value removes from / (its internal placeholder character left out).
const VARIABLE_ROOT = /^["']*\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|([A-Za-z_][A-Za-z0-9_]*))["']*\\?\/(?:[*?[{]|\$|\/|["']|$)/u;
const POSITIONAL_ROOT = /^["']*\$(?:\{(?:[0-9]+|[@*!])(?::?-(?:["']{2}|"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?)?)?\}|[0-9@*!])["']*\\?\/(?:[*?[{]|\$|\/|["']|$)/u;
const LEADING_WORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "sudo", "command", "exec", "nohup", "env"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** WHAT: Checks a bypass Bash dialog. WHY: Keeps unsafe expansions and broad removals from running unseen. */
export function bashPermissionDecision(command, home = "") {
  const script = String(command || "");
  const deny = (message) => ({ behavior: "deny", message });
  const stopping = stoppingRmTargets(script);
  if (stopping.length) return deny(formatRmRefusal(stopping));
  const blocks = heredocBlocks(script);
  if (unreadableHeredoc(script, blocks)) return deny("Nothing ran. Quote the heredoc tag and use one complete delimiter per command, or use the file tool.");
  for (const block of blocks) {
    if (!block.quoted && /(^|[^\\])(?:\\\\)*(?:\$\(|`)/mu.test(block.body)) return deny("Nothing ran. The shell runs text in backticks or substitutions; quote the heredoc tag or write the file with the file tool.");
    if (block.shell) {
      const nested = bashPermissionDecision(block.body, home);
      if (nested.behavior === "deny") return nested;
    }
  }
  for (const words of simpleCommands(script)) {
    if (words.some((word) => !(word.startsWith("'") && word.endsWith("'"))
        && /(?:\$\([^)]*|`[^`]*)(?:\brm\b|\brmdir\b)/u.test(word))) {
      return deny("Nothing ran. Run the command substitution separately and use a narrower literal removal target.");
    }
    let i = 0;
    while (i < words.length && (LEADING_WORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[i]))) i++;
    if (SHELLS.has((words[i] || "").replace(/^\\/u, "")) && words.includes("-c")) {
      const nested = bashPermissionDecision(unquote(words[words.indexOf("-c") + 1] || ""), home);
      if (nested.behavior === "deny") return nested;
    }
    if (!["rm", "rmdir"].includes((words[i] || "").replace(/^\\/u, ""))) continue;
    for (const word of words.slice(i + 1)) {
      if (word.startsWith("-")) continue;
      let path = unquote(word);
      if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
      path = path.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/u, home);
      if (path.includes("$")) {
        const resolved = resolveRmTarget(word, script, home);
        if (resolved.why) return deny(`Nothing ran. ${word} is not a known literal path; write the literal path.`);
        for (const value of resolved.paths) {
          const why = unsafeRmPath(value, home);
          if (why) return deny(`Nothing ran. ${why}; use a narrower literal path.`);
        }
        continue;
      }
      if (!path.startsWith("/")) continue;
      const why = unsafeRmPath(path, home);
      if (why) return deny(`Nothing ran. ${why}; use a narrower literal path.`);
    }
  }
  return { behavior: "allow" };
}

function heredocBlocks(script) {
  const blocks = [];
  const start = /([^\n]*?)(?<!<)<<(-?)(?!<)[ \t]*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\3|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))(?=[\s;|&<>]|$)[^\n]*\n/gu;
  let match;
  while ((match = start.exec(script))) {
    const tag = match[4] || match[5] || match[6];
    const end = new RegExp(`^${match[2] ? "\\t*" : ""}${tag}[\\t ]*$`, "mu").exec(script.slice(start.lastIndex));
    if (!end) continue;
    const body = script.slice(start.lastIndex, start.lastIndex + end.index);
    blocks.push({ body, open: match.index + match[1].length, end: start.lastIndex + end.index + end[0].length,
      quoted: Boolean(match[3] || match[5]), shell: /(?:^|[;&|\s])(?:bash|sh|zsh|dash)(?:\s|$)/u.test(match[1]) });
    start.lastIndex += end.index + end[0].length;
  }
  return blocks;
}

function unreadableHeredoc(script, blocks) {
  let quote = "", pending = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "#" && (i === 0 || /[\s;&|]/u.test(script[i - 1]))) {
      const newline = script.indexOf("\n", i); i = newline < 0 ? script.length : newline - 1; continue;
    }
    if (c === "<" && script[i - 1] !== "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      const block = blocks.find((b) => b.open === i);
      if (!block || pending) return true;
      pending = block;
      i++;
    } else if (c === "\n" && pending) { i = pending.end - 1; pending = null; }
  }
  return false;
}

/**
 * WHAT: Collects the rm and rmdir targets in a command that Claude Code stops for a person.
 * WHY: Keeps a pane from waiting on a removal the agent can write in an accepted form.
 */
export function stoppingRmTargets(command) {
  const found = [];
  for (const block of heredocBlocks(String(command || ""))) {
    if (block.shell) found.push(...stoppingRmTargets(block.body));
  }
  let changedDirectory = false;
  for (const words of simpleCommands(String(command || ""))) {
    let i = 0;
    while (i < words.length && (LEADING_WORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[i]))) i++;
    const name = (words[i] || "").replace(/^\\/u, "");
    const args = words.slice(i + 1);
    if (name === "cd" || name === "pushd") changedDirectory = true;
    if (SHELLS.has(name)) {
      const script = args[args.indexOf("-c") + 1];
      if (args.includes("-c") && script) found.push(...stoppingRmTargets(unquote(script)));
      continue;
    }
    if (name !== "rm" && name !== "rmdir") continue;
    let options = true;
    for (const arg of args) {
      if (options && arg === "--") { options = false; continue; }
      if (options && /^-/u.test(arg)) continue;
      const why = stopReason(arg, changedDirectory);
      if (why) found.push({ target: arg, ...why });
    }
  }
  return found;
}

function stopReason(target, changedDirectory) {
  const variable = VARIABLE_ROOT.exec(target);
  if (variable) {
    const name = variable[1] ?? variable[2];
    const tail = target.slice(target.indexOf("/", target.indexOf("$")));
    return {
      why: `when $${name} is empty, ${target} removes from /`,
      rewrite: `"\${${name}:?}"${tail}`,
    };
  }
  if (POSITIONAL_ROOT.test(target)) {
    return { why: `when the positional is empty, ${target} removes from /`, rewrite: "a named variable written as \"${NAME:?}\"/..., or the literal path" };
  }
  if (/\$\(|`/u.test(target)) {
    return { why: `${target} is the output of a command substitution, which the check cannot read`, rewrite: "run the substitution on its own first, then rm the literal paths it prints" };
  }
  const relative = !/^["']*(?:\/|~|\$)/u.test(target);
  const glob = /[*?[]/u.test(target.replace(/'[^']*'|"[^"]*"/gu, ""));
  if (relative && glob && (changedDirectory || /(?:^|\/)\.\.(?:\/|$)/u.test(target))) {
    return { why: `${target} is a relative glob ${changedDirectory ? "after cd" : "through .."}, which the check cannot resolve`, rewrite: "the literal absolute path instead of cd or .." };
  }
  return null;
}

/** The simple commands of a script as raw words, quotes kept; heredoc bodies and comments left out. */
function simpleCommands(script) {
  const commands = [];
  const heredocs = [];
  let words = [];
  let word = "";
  const endWord = () => { if (word) words.push(word); word = ""; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  const closing = (from, open, close) => {
    let depth = 0;
    for (let j = from; j < script.length; j++) {
      if (script[j] === "\\") { j++; continue; }
      if (script[j] === open) depth++;
      else if (script[j] === close && --depth === 0) return j;
    }
    return script.length - 1;
  };
  for (let i = 0; i < script.length;) {
    const c = script[i];
    if (c === "\\") { word += script.slice(i, i + 2); i += 2; continue; }
    if (c === "'") { const j = script.indexOf("'", i + 1); const end = j < 0 ? script.length : j + 1; word += script.slice(i, end); i = end; continue; }
    if (c === "\"") {
      let j = i + 1;
      while (j < script.length && script[j] !== "\"") j += script[j] === "\\" ? 2 : 1;
      word += script.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "`") { const j = script.indexOf("`", i + 1); const end = j < 0 ? script.length : j + 1; word += script.slice(i, end); i = end; continue; }
    if (c === "$" && (script[i + 1] === "(" || script[i + 1] === "{")) {
      const end = closing(i + 1, script[i + 1], script[i + 1] === "(" ? ")" : "}") + 1;
      word += script.slice(i, end); i = end; continue;
    }
    if (c === "#" && !word) { const j = script.indexOf("\n", i); i = j < 0 ? script.length : j; continue; }
    if (c === "<" && script[i - 1] !== "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      const tag = /^<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/u.exec(script.slice(i));
      if (tag) { endWord(); heredocs.push(tag[2] || tag[3] || tag[4]); i += tag[0].length; continue; }
    }
    if (c === "\n") {
      endCommand();
      i++;
      while (heredocs.length) {
        const end = new RegExp(`^[\\t ]*${heredocs.shift()}[\\t ]*$`, "mu").exec(script.slice(i));
        i = end ? i + end.index + end[0].length : script.length;
      }
      continue;
    }
    if (/[;&|(){}]/u.test(c)) { endCommand(); i++; continue; }
    if (/\s/u.test(c)) { endWord(); i++; continue; }
    word += c;
    i++;
  }
  endCommand();
  return commands;
}

function unquote(word) {
  if (word.startsWith("'") && word.endsWith("'")) return word.slice(1, -1);
  if (word.startsWith("\"") && word.endsWith("\"")) return word.slice(1, -1).replace(/\\(["\\$`])/gu, "$1");
  return word;
}

/**
 * WHAT: Formats the refusal an agent reads when its command holds such a target.
 * WHY: Keeps the agent's retry to the one form Claude Code accepts without asking a person.
 */
export function formatRmRefusal(found) {
  return [
    "Claude Code would stop this command for a person, even in bypass mode, and the pane would wait: " + found.map((f) => f.why).join("; ") + ".",
    "Nothing ran. Write it again with " + found.map((f) => `${f.target} as ${f.rewrite}`).join("; ") + ", then run it.",
  ].join(" ");
}
