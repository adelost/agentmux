// Persistent todo list backed by tasks.md markdown file.
//
// Format reuses the existing `~/.openclaw/workspace/memory/tasks.md`:
//
//   > summary: ...
//   > why: ...
//
//   # Tasks
//
//   ## Idag / snart
//   - [ ] Some active task <!-- id:5 created:2026-05-27 -->
//
//   ## Parkerat (tar tag i senare)
//   - [ ] Lower-priority task <!-- id:3 created:2026-05-25 -->
//
//   ## Väntar på
//   _(Saker som blockas av andra)_
//
//   ## Klart (senaste)
//   - [x] Done task <!-- id:2 created:2026-05-20 closed:2026-05-26 -->
//
// IDs live in hidden HTML comments so markdown renders cleanly but the parser
// can find them. addTodo() allocates the next free id. doneTodo() / rmTodo()
// preserve original comments + section order.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export const DEFAULT_TODOS_PATH =
  process.env.AMUX_TODOS_PATH ||
  `${process.env.HOME}/.openclaw/workspace/memory/tasks.md`;

export const SECTION_NOW = "Idag / snart";
export const SECTION_PARKED = "Parkerat (tar tag i senare)";
export const SECTION_BLOCKED = "Väntar på";
export const SECTION_DONE = "Klart (senaste)";

export const ACTIVE_SECTIONS = [SECTION_NOW, SECTION_PARKED, SECTION_BLOCKED];
export const ALL_SECTIONS = [...ACTIVE_SECTIONS, SECTION_DONE];

const DEFAULT_HEADER = `> summary: Aktiva uppgifter med deadlines. Format: \`— deadline: YYYY-MM-DD\` för parsning. Lintern varnar för passerade deadlines och tasks utan deadline.
> why: Aktiv uppgiftslista. Lintern kollar deadlines.

# Tasks
`;

const EMPTY_NOW = "_(inget just nu)_";
const EMPTY_BLOCKED = "_(Saker som blockas av andra)_";
const EMPTY_GENERIC = "_(inget)_";

const todayIso = () => new Date().toISOString().slice(0, 10);

// Match `- [ ] text` or `- [x] text` with optional trailing `<!-- ... -->`
const ITEM_RE = /^-\s+\[( |x|X)\]\s+(.*?)(?:\s+<!--\s*(.*?)\s*-->)?\s*$/;

const parseMeta = (commentBody) => {
  // "id:5 created:2026-05-27 closed:2026-05-26 prio:medium"
  const meta = {};
  if (!commentBody) return meta;
  for (const tok of commentBody.split(/\s+/).filter(Boolean)) {
    const idx = tok.indexOf(":");
    if (idx < 0) continue;
    const k = tok.slice(0, idx);
    const v = tok.slice(idx + 1);
    meta[k] = v;
  }
  if (meta.id !== undefined) meta.id = Number(meta.id);
  return meta;
};

const serializeMeta = (meta) => {
  const keys = ["id", "created", "closed", "prio"];
  const parts = [];
  for (const k of keys) {
    if (meta[k] !== undefined && meta[k] !== null && meta[k] !== "") {
      parts.push(`${k}:${meta[k]}`);
    }
  }
  // Any extra keys we don't know about
  for (const k of Object.keys(meta)) {
    if (!keys.includes(k) && meta[k] !== undefined && meta[k] !== null) {
      parts.push(`${k}:${meta[k]}`);
    }
  }
  return parts.length ? ` <!-- ${parts.join(" ")} -->` : "";
};

const serializeItem = (item) => {
  const checkbox = item.done ? "x" : " ";
  return `- [${checkbox}] ${item.text}${serializeMeta(item.meta)}`;
};

/**
 * Parse the tasks.md text into structured form.
 * Returns: { header, sections: [{ name, lines, items }], footer }
 * - `lines` preserves any non-item text inside a section (e.g. placeholders).
 * - Unknown sections are kept as-is in order encountered.
 */
export function parseTodos(text) {
  const lines = text.split("\n");
  const headerLines = [];
  const sections = [];
  let current = null;
  let inHeader = true;

  for (const line of lines) {
    if (inHeader) {
      if (line.startsWith("## ")) {
        inHeader = false;
        // fall through into section handler
      } else {
        headerLines.push(line);
        continue;
      }
    }
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim();
      current = { name, lines: [], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // text between # Tasks and first ## — treat as header continuation
      headerLines.push(line);
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      const done = m[1].toLowerCase() === "x";
      const text = m[2];
      const meta = parseMeta(m[3]);
      current.items.push({ done, text, meta });
    } else {
      current.lines.push(line);
    }
  }

  // Trim trailing blank lines from header
  while (headerLines.length && headerLines[headerLines.length - 1] === "") {
    headerLines.pop();
  }

  return {
    header: headerLines.join("\n"),
    sections,
  };
}

/**
 * Serialize back to markdown. Section order is preserved as-is from the
 * parsed structure (which preserves input order). Empty sections get a
 * placeholder line.
 */
export function serializeTodos(parsed) {
  const out = [];
  out.push(parsed.header);
  out.push("");
  for (const sec of parsed.sections) {
    out.push(`## ${sec.name}`);
    if (sec.items.length === 0) {
      // Use original placeholder if it was there, else generic
      const hasPlaceholder = sec.lines.some((l) => /^_\(.*\)_$/.test(l.trim()));
      if (hasPlaceholder) {
        for (const l of sec.lines) out.push(l);
      } else {
        if (sec.name === SECTION_NOW) out.push(EMPTY_NOW);
        else if (sec.name === SECTION_BLOCKED) out.push(EMPTY_BLOCKED);
        else out.push(EMPTY_GENERIC);
      }
    } else {
      // Keep any non-item lines (like comments inside section)
      const placeholderLines = sec.lines.filter((l) => !/^_\(.*\)_$/.test(l.trim()) && l.trim() !== "");
      for (const l of placeholderLines) out.push(l);
      for (const item of sec.items) out.push(serializeItem(item));
    }
    out.push("");
  }
  // Trim trailing blank
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/**
 * Compute the next free id across all items (active + done).
 * Always returns max(existing ids) + 1, starting from 1.
 */
export function nextId(parsed) {
  let max = 0;
  for (const sec of parsed.sections) {
    for (const item of sec.items) {
      const id = Number(item.meta.id);
      if (Number.isFinite(id) && id > max) max = id;
    }
  }
  return max + 1;
}

const findSection = (parsed, name) => parsed.sections.find((s) => s.name === name);
const ensureSection = (parsed, name) => {
  let sec = findSection(parsed, name);
  if (!sec) {
    sec = { name, lines: [], items: [] };
    // Insert in canonical order if it's a known section
    const canonical = ALL_SECTIONS.indexOf(name);
    if (canonical >= 0) {
      // Find insertion point: after the last earlier-canonical section
      let insertAt = parsed.sections.length;
      for (let i = 0; i < parsed.sections.length; i++) {
        const otherIdx = ALL_SECTIONS.indexOf(parsed.sections[i].name);
        if (otherIdx < 0 || otherIdx > canonical) {
          insertAt = i;
          break;
        }
      }
      parsed.sections.splice(insertAt, 0, sec);
    } else {
      parsed.sections.push(sec);
    }
  }
  return sec;
};

/**
 * Add a new todo. Returns new parsed object (mutates input — callers
 * should treat parsed as a working draft).
 */
export function addTodo(parsed, text, options = {}) {
  const section = options.section || SECTION_NOW;
  const id = options.id || nextId(parsed);
  const created = options.created || todayIso();
  const meta = { id, created };
  if (options.prio) meta.prio = options.prio;
  const item = { done: false, text, meta };
  const sec = ensureSection(parsed, section);
  sec.items.push(item);
  return { parsed, item };
}

/**
 * Find an item by numeric id or by case-insensitive substring of text.
 * Returns { section, item, index } or null.
 */
export function findItem(parsed, idOrSubstring) {
  const asNum = Number(idOrSubstring);
  const isNum = Number.isFinite(asNum) && String(asNum) === String(idOrSubstring).trim();
  const sub = String(idOrSubstring).toLowerCase();
  for (const section of parsed.sections) {
    for (let i = 0; i < section.items.length; i++) {
      const item = section.items[i];
      if (isNum && item.meta.id === asNum) return { section, item, index: i };
      if (!isNum && item.text.toLowerCase().includes(sub)) return { section, item, index: i };
    }
  }
  return null;
}

/**
 * Mark a todo as done. Moves it from its current (active) section to
 * SECTION_DONE, sets `closed:` date, and flips checkbox.
 *
 * Returns { found: bool, item, fromSection }.
 */
export function doneTodo(parsed, idOrSubstring, closedDate = todayIso()) {
  const hit = findItem(parsed, idOrSubstring);
  if (!hit) return { found: false };
  if (hit.section.name === SECTION_DONE) {
    // already done, just refresh date
    hit.item.meta.closed = closedDate;
    return { found: true, item: hit.item, fromSection: SECTION_DONE };
  }
  const fromSection = hit.section.name;
  hit.section.items.splice(hit.index, 1);
  hit.item.done = true;
  hit.item.meta.closed = closedDate;
  const done = ensureSection(parsed, SECTION_DONE);
  // Insert at top so most-recently-closed is first
  done.items.unshift(hit.item);
  return { found: true, item: hit.item, fromSection };
}

/**
 * Remove an item permanently (does NOT move to done).
 * Returns { found: bool, item }.
 */
export function rmTodo(parsed, idOrSubstring) {
  const hit = findItem(parsed, idOrSubstring);
  if (!hit) return { found: false };
  hit.section.items.splice(hit.index, 1);
  return { found: true, item: hit.item };
}

/**
 * List all items in active sections (Idag / Parkerat / Väntar).
 * Returns flat array with section names attached.
 */
export function listActive(parsed) {
  const out = [];
  for (const section of parsed.sections) {
    if (!ACTIVE_SECTIONS.includes(section.name)) continue;
    for (const item of section.items) {
      out.push({ ...item, section: section.name });
    }
  }
  return out;
}

const DEADLINE_RE = /[—-]\s*deadline:\s*(\d{4}-\d{2}-\d{2})/;

/** Deadline date (YYYY-MM-DD) parsed from an item's text, or null. */
export function itemDeadline(item) {
  const m = String(item?.text || "").match(DEADLINE_RE);
  return m ? m[1] : null;
}

/**
 * Items the MORNING REMINDER may mention. "Idag / snart" always earns its
 * ping; parked/blocked items only when their deadline is due (<= today).
 * A daily nudge about undated "tar tag i senare" is wallpaper, and
 * wallpaper kills the reminder — same economics as the drift-guard:
 * fire on signal, not on shelf contents. Sorted overdue → dated → undated.
 */
export function listRemindable(parsed, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  for (const section of parsed.sections) {
    if (!ACTIVE_SECTIONS.includes(section.name)) continue;
    for (const item of section.items) {
      const deadline = itemDeadline(item);
      const due = deadline !== null && deadline <= today;
      if (section.name !== SECTION_NOW && !due) continue;
      out.push({
        ...item,
        section: section.name,
        deadline,
        overdue: deadline !== null && deadline < today,
      });
    }
  }
  return out.sort((a, b) =>
    (Number(b.overdue) - Number(a.overdue)) ||
    String(a.deadline || "9999").localeCompare(String(b.deadline || "9999")));
}

/**
 * List recently-completed items (newest first, default last 20).
 */
export function listDone(parsed, limit = 20) {
  const done = findSection(parsed, SECTION_DONE);
  if (!done) return [];
  return done.items.slice(0, limit).map((item) => ({ ...item, section: SECTION_DONE }));
}

// ─── IO ─────────────────────────────────────────────────────────────────────

export function loadTodos(path = DEFAULT_TODOS_PATH) {
  if (!existsSync(path)) {
    return parseTodos(DEFAULT_HEADER + "\n## " + SECTION_NOW + "\n" + EMPTY_NOW + "\n");
  }
  return parseTodos(readFileSync(path, "utf-8"));
}

export function saveTodos(parsed, path = DEFAULT_TODOS_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTodos(parsed));
}

// ─── Pretty formatters ─────────────────────────────────────────────────────

/**
 * Format an item for terminal output: "[#5] Idag — Bygg s22-scripts"
 */
export function formatItemLine(item, opts = {}) {
  const id = item.meta?.id !== undefined ? `[#${item.meta.id}]` : "[#?]";
  const section = opts.includeSection && item.section ? ` ${item.section} —` : "";
  const created = opts.includeCreated && item.meta?.created ? ` (${item.meta.created})` : "";
  return `${id}${section} ${item.text}${created}`;
}

/**
 * Format the whole active list as a multi-line string for `amux todo`.
 */
export function formatActiveList(parsed) {
  const out = [];
  for (const sectionName of ACTIVE_SECTIONS) {
    const sec = findSection(parsed, sectionName);
    if (!sec || sec.items.length === 0) continue;
    out.push(`## ${sectionName}`);
    for (const item of sec.items) {
      out.push("  " + formatItemLine(item));
    }
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length === 0) return "(inga aktiva todos)";
  return out.join("\n");
}

/**
 * Short summary suitable for a push notification body (≤200 chars).
 * "5 aktiva: bygg X, köp Y, fixa Z (+2 fler)"
 */
export function formatReminderSummary(parsed, maxChars = 180, { today } = {}) {
  const items = listRemindable(parsed, today ? { today } : {});
  if (items.length === 0) return "";
  const titles = items.map((it) => (it.overdue ? "🔴 " : "") + it.text);
  let body = `${items.length} aktiva todo${items.length === 1 ? "" : "s"}: `;
  const remaining = maxChars - body.length;
  let included = 0;
  let acc = "";
  for (let i = 0; i < titles.length; i++) {
    const piece = (i === 0 ? "" : ", ") + titles[i];
    if (acc.length + piece.length > remaining - 20) break;
    acc += piece;
    included++;
  }
  body += acc;
  if (included < titles.length) body += ` (+${titles.length - included} fler)`;
  return body;
}
