// Semantic tool-call display shared by Claude and Codex JSONL readers.
// Provider-specific envelopes stay internal; Discord sees user-facing verbs.

const AMUX_COMMANDS = new Set([
  "asks", "attach", "compact", "doctor", "done", "dream", "edit", "esc",
  "image", "janitor", "label", "labels", "log", "memory", "notifyuser",
  "playwright-reap", "ps", "queue", "remind", "search", "select", "serve", "stop",
  "sync", "timeline", "top", "wait", "watch",
]);

export function describeToolCall(name, input = {}, context = {}) {
  const key = String(name || "tool").toLowerCase();

  if (key === "exec_command" || key === "bash") {
    return describeCommand(input.cmd ?? input.command ?? "", input.workdir ?? context.workdir);
  }
  if (key === "write_stdin" || key === "wait") {
    const id = input.session_id ?? input.cell_id;
    return { content: id == null ? "Wait for process" : `Wait for process ${id}`, kind: "wait" };
  }
  if (key === "apply_patch" || key === "edit" || key === "write" || key === "multiedit") {
    const paths = input.patchPaths || [input.file_path ?? input.path].filter(Boolean);
    return describeEdit(paths, context.workdir);
  }
  if (key === "read") {
    return { content: `Read ${displayPath(input.file_path ?? input.path ?? "file", context.workdir)}`, kind: "tool" };
  }
  if (key === "view_image") {
    const path = input.path ? ` ${displayPath(input.path, context.workdir)}` : "";
    return { content: `View image${path}`, kind: "tool" };
  }
  if (key === "glob" || key === "grep" || key === "search") {
    const pattern = compact(input.pattern ?? input.query ?? input.q ?? "", 64);
    const scope = input.path ? ` in ${displayPath(input.path, context.workdir)}` : "";
    return { content: `Search ${pattern || "files"}${scope}`, kind: "tool" };
  }
  if (key === "list_agents") return { content: "List agents", kind: "tool" };
  if (key === "web__run") return { content: "Search web", kind: "tool" };
  if (key === "task" || key === "agent") {
    const target = input.subagent_type ?? input.description ?? "agent";
    return { content: `Delegate to ${compact(target, 64)}`, kind: "tool" };
  }

  const args = Object.entries(input || {}).slice(0, 2)
    .map(([arg, value]) => `${arg}=${compact(value, 36)}`)
    .join(" ");
  const label = humanize(name || "operation");
  return { content: args ? `${label} ${args}` : label, kind: "tool" };
}

export function describeCustomExec(source) {
  const calls = extractNestedToolCalls(source);
  if (!calls.length) {
    const patchPaths = extractPatchPaths(source);
    if (patchPaths.length) return describeEdit(patchPaths);
    return { content: "Run internal operation (details unavailable)", kind: "tool" };
  }

  const displays = calls.map(({ name, input }) => {
    if (name === "apply_patch") return describeToolCall(name, { ...input, patchPaths: extractPatchPaths(source) });
    return describeToolCall(name, input);
  });
  if (displays.length === 1) return displays[0];

  // Polling is noise, and inter-agent sends already have an immediate,
  // delivery-verified receipt. Exclude both when they share an orchestration
  // wrapper with other operations; preserve the semantic kind when alone so
  // the watcher can suppress the duplicate invocation entirely.
  const visible = displays.filter((display) => display.kind !== "wait" && display.kind !== "inter-agent-send");
  if (!visible.length) return displays.find((display) => display.kind === "inter-agent-send") ?? displays[0];
  if (visible.length === 1) return visible[0];

  const preview = visible.slice(0, 3).map((display) => display.content).join(" | ");
  const more = visible.length > 3 ? ` | +${visible.length - 3} operations` : "";
  return { content: `${visible.length} operations: ${compact(preview + more, 180)}`, kind: "tool" };
}

export function extractNestedToolCalls(source) {
  const text = String(source || "");
  const calls = [];
  let quote = null;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (!text.startsWith("tools.", i)) continue;

    const nameStart = i + 6;
    const nameMatch = text.slice(nameStart).match(/^([A-Za-z0-9_]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    let open = nameStart + name.length;
    while (/\s/.test(text[open] || "")) open++;
    if (text[open] !== "(") continue;

    const parsed = balancedArgument(text, open);
    if (!parsed) continue;
    calls.push({ name, input: parseInput(parsed.argument), raw: parsed.argument });
    i = parsed.end;
  }
  return calls;
}

function balancedArgument(text, open) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) {
      return { argument: text.slice(open + 1, i).trim(), end: i };
    }
  }
  return null;
}

function parseInput(raw) {
  if (!raw.startsWith("{")) return {};
  try { return JSON.parse(raw); }
  catch {
    // Codex orchestration source is JavaScript, not guaranteed JSON. Parse the
    // common flat scalar fields without eval so `{path:"x", detail:"high"}`
    // remains inspectable while arbitrary source stays inert.
    const out = {};
    const field = /(?:^|[,{}]\s*)["']?([A-Za-z0-9_]+)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|true|false|null)/g;
    let match;
    while ((match = field.exec(raw))) {
      const [, key, token] = match;
      try {
        if (token.startsWith("'")) out[key] = token.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        else out[key] = JSON.parse(token);
      } catch { /* ignore malformed scalar */ }
    }
    return out;
  }
}

function extractPatchPaths(source) {
  const paths = [];
  const pattern = /\*\*\* (?:Update|Add|Delete) File: ([^\\\r\n"]+)/g;
  let match;
  while ((match = pattern.exec(String(source || "")))) paths.push(match[1].trim());
  return [...new Set(paths)];
}

function describeCommand(command, workdir) {
  const raw = String(command || "").trim();
  const send = interAgentTarget(raw);
  if (send) return { content: `Send -> ${send}`, kind: "inter-agent-send" };

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] || "command";
  const suffix = lines.length > 1 ? ` | +${lines.length - 1} commands` : "";
  if (/^(?:rg|grep)\s/.test(first)) {
    return { content: `Search ${compact(first.replace(/^(?:rg|grep)\s+/, ""), 78)}${suffix}`, kind: "tool" };
  }
  if (/^(?:find|fd)\s/.test(first)) {
    return { content: `Search files: ${compact(first.replace(/^(?:find|fd)\s+/, ""), 72)}${suffix}`, kind: "tool" };
  }
  return { content: `Run ${compact(first, 82)}${suffix}`, kind: "tool" };
}

function interAgentTarget(command) {
  const match = command.match(/(?:^|[;&|]\s*)(?:amux|ax)\s+([A-Za-z0-9_-]+)(?:\s+-p\s*(\d+))?\s+["']/);
  if (!match || AMUX_COMMANDS.has(match[1])) return null;
  return `${match[1]}:${match[2] ?? 0}`;
}

function describeEdit(paths, workdir) {
  const clean = [...new Set((paths || []).filter(Boolean).map(String))];
  if (!clean.length) return { content: "Edit files", kind: "tool" };
  if (clean.length === 1) return { content: `Edit ${displayPath(clean[0], workdir)}`, kind: "tool" };
  const names = clean.slice(0, 5).map((path) => path.split(/[\\/]/).filter(Boolean).at(-1)).join(" | ");
  const more = clean.length > 5 ? ` | +${clean.length - 5} files` : "";
  return { content: `Edit ${clean.length} files: ${names}${more}`, kind: "tool" };
}

function displayPath(value, workdir) {
  let path = String(value || "");
  const root = String(workdir || "").replace(/\/$/, "");
  if (root && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!root && path.startsWith("/") && parts.length > 4) return `.../${parts.slice(-3).join("/")}`;
  if (path.length <= 78) return path;
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : `...${path.slice(-75)}`;
}

function compact(value, max) {
  const oneLine = String(value ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function humanize(value) {
  const words = String(value || "operation").replace(/^.*__/, "").replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Operation";
}
