import {
  existsSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { basename, join, relative } from "path";
import { dailyPolicyFor, loadMemoryPolicy, localDateKey } from "./memory-policy.mjs";

const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const TEMPLATE_BY_TAG = {
  dating: "memory/people/DATING-TEMPLATE.md",
  person: "memory/people/TEMPLATE.md",
  daily: "memory/TEMPLATE.md",
  "empathy-radar": "memory/people/EMPATHY-RADAR-TEMPLATE.md",
  ref: "memory/references/TEMPLATE.md",
  reference: "memory/references/TEMPLATE.md",
  "daily-fragment": null,
};

const linesOf = (text) => {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

function markdownFiles(dir, recursive = false) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && recursive) out.push(...markdownFiles(path, true));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

function requiredHeadings(templatePath) {
  if (!existsSync(templatePath)) return [];
  return linesOf(readFileSync(templatePath, "utf-8"))
    .filter((line) => /^## .+ <!-- required -->$/.test(line))
    .map((line) => line.replace(/ <!-- required -->$/, ""));
}

function loadIgnores(memoryDir) {
  const path = join(memoryDir, ".lint-ignore");
  if (!existsSync(path)) return new Set();
  return new Set(linesOf(readFileSync(path, "utf-8"))
    .map((line) => line.replace(/#.*$/, "").trim().split(/\s+/)[0])
    .filter(Boolean));
}

function hasFrontmatterDescription(lines) {
  if (lines[0] !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return false;
    if (/^description:\s*\S/.test(lines[i])) return true;
  }
  return false;
}

function latestDreamSentinel(text) {
  const hits = [...text.matchAll(/<!-- amux-dream-run:([^ ]+) ([^ ]+) \((\d+) panes ok \/ (\d+) failed\) -->/g)];
  if (!hits.length) return null;
  const m = hits.at(-1);
  return { date: m[1], time: m[2], ok: Number(m[3]), failed: Number(m[4]) };
}

export function lintMemory(workspace, { now = new Date(), policy: suppliedPolicy, home = process.env.HOME } = {}) {
  const root = workspace;
  const memoryDir = join(root, "memory");
  if (!existsSync(memoryDir)) throw new Error(`${memoryDir}: memory directory not found`);
  const policy = suppliedPolicy || loadMemoryPolicy(root);
  const ignores = loadIgnores(memoryDir);
  const findings = [];
  const add = (severity, code, file, message, extra = {}) => findings.push({
    severity, code, file: file ? relative(root, file) : null, message, ...extra,
  });

  const allMemoryMd = markdownFiles(memoryDir, true);
  const immediateMemoryMd = markdownFiles(memoryDir);
  const referenceMd = markdownFiles(join(memoryDir, "references"));
  const peopleMd = markdownFiles(join(memoryDir, "people"))
    .filter((file) => !basename(file).includes("TEMPLATE"));
  const dailyFiles = immediateMemoryMd.filter((file) => DAILY_RE.test(basename(file)));
  const compactable = [];

  // Template tags and required headings.
  for (const file of allMemoryMd) {
    if (basename(file).includes("TEMPLATE")) continue;
    const text = readFileSync(file, "utf-8");
    const tag = linesOf(text).slice(0, 5).join("\n").match(/<!-- template: ([a-z-]+) -->/)?.[1];
    if (!tag) continue;
    const templateRel = TEMPLATE_BY_TAG[tag];
    if (!(tag in TEMPLATE_BY_TAG)) {
      add("warning", "template_unknown", file, `unknown template tag "${tag}"`);
      continue;
    }
    if (templateRel === null) continue;
    if (!existsSync(join(root, templateRel))) {
      add("warning", "template_missing_file", file, `template file missing for "${tag}": ${templateRel}`);
      continue;
    }
    for (const heading of requiredHeadings(join(root, templateRel))) {
      const sourceLines = text.split(/\r?\n/);
      const headingIdx = sourceLines.findIndex((line) => line.startsWith(heading));
      if (headingIdx === -1) {
        add("warning", "template_missing", file, `missing required heading "${heading}"`);
      } else {
        const body = sourceLines.slice(headingIdx + 1).find((line) => line.trim() && !line.startsWith("<!--"));
        if (!body || body.startsWith("## ")) add("warning", "template_empty", file, `required heading "${heading}" is empty`);
      }
    }
  }

  // Daily structure + age-aware compact policy. Today/yesterday stay visible
  // but are never compact candidates.
  const dailyRequired = requiredHeadings(join(memoryDir, "TEMPLATE.md"));
  for (const file of dailyFiles) {
    const text = readFileSync(file, "utf-8");
    const lineCount = linesOf(text).length;
    for (const heading of dailyRequired) {
      if (!text.split(/\r?\n/).some((line) => line.startsWith(heading))) {
        add("warning", "daily_structure", file, `missing required heading "${heading}"`);
      }
    }
    const dateKey = basename(file, ".md");
    const rule = dailyPolicyFor(dateKey, policy, now);
    if (rule.protected) {
      if (lineCount > policy.recentDailyMaxLines) {
        add("info", "daily_protected_large", file, `${lineCount} lines; protected as today/yesterday`);
      }
    } else if (lineCount > rule.maxLines) {
      const finding = {
        severity: "warning", code: "daily_compact", file: relative(root, file),
        message: `${lineCount} lines in ${rule.ageBand} band; compact toward ${rule.targetLines}`,
        lines: lineCount, targetLines: rule.targetLines, dateKey,
      };
      findings.push(finding);
      compactable.push({ path: file, ...finding });
    } else if (lineCount > Math.round(rule.maxLines * 0.7)) {
      add("info", "daily_large", file, `${lineCount} lines (limit ${rule.maxLines})`);
    }
  }

  // Backtick links to concrete memory markdown files.
  const linkSources = [
    ...markdownFiles(root), ...immediateMemoryMd, ...referenceMd, ...peopleMd,
  ];
  for (const file of linkSources) {
    const text = readFileSync(file, "utf-8");
    if (DAILY_RE.test(basename(file))) continue;
    for (const match of text.matchAll(/`(memory\/[^`]*\.md)`/g)) {
      const ref = match[1];
      if (/[{}*]|YYYY/.test(ref)) continue;
      if (!existsSync(join(root, ref))) add("warning", "broken_link", file, `broken link: ${ref}`);
    }
  }

  const memoryIndex = join(root, "MEMORY.md");
  if (existsSync(memoryIndex)) {
    const bytes = statSync(memoryIndex).size;
    if (bytes > policy.memoryMaxBytes) {
      add("warning", "memory_size", memoryIndex, `${bytes} bytes exceeds ${policy.memoryMaxBytes}; curate manually`);
    } else if (bytes > policy.memoryMaxBytes * 0.75) {
      add("info", "memory_near_limit", memoryIndex, `${bytes} bytes near ${policy.memoryMaxBytes} limit`);
    }
  }

  const peopleIndex = join(memoryDir, "people.md");
  if (existsSync(peopleIndex)) {
    const peopleIndexText = readFileSync(peopleIndex, "utf-8");
    const count = linesOf(peopleIndexText).length;
    if (count > policy.peopleIndexMaxLines) add("warning", "people_index_size", peopleIndex, `${count} lines exceeds ${policy.peopleIndexMaxLines}`);

    let checks = [];
    let current = null;
    const finishEntry = () => {
      if (!current || checks.includes("none") || /se .*ovan/i.test(current.lines.join("\n"))) return;
      if (current.lines.length > 15) add("warning", "people_entry_size", peopleIndex, `${current.name}: ${current.lines.length} lines exceeds 15`);
      const body = current.lines.join("\n");
      if (checks.includes("lärdom") && !/lärdom/i.test(body)) add("warning", "people_entry_lesson", peopleIndex, `${current.name}: missing Lärdom`);
      if (checks.includes("link") && !/→.*\.md/.test(body)) add("info", "people_entry_link", peopleIndex, `${current.name}: no detail link`);
      if (checks.includes("senast") && !/senast/i.test(body)) add("info", "people_entry_recent", peopleIndex, `${current.name}: no Senast field`);
    };
    for (const line of linesOf(peopleIndexText)) {
      if (line.startsWith("## ")) {
        finishEntry();
        current = null;
        checks = (line.match(/<!-- entry-check: ([^>]+) -->/)?.[1] || "")
          .split(",").map((rule) => rule.trim()).filter(Boolean);
      } else if (/^\*\*[^*]+\*\*.*—/.test(line)) {
        finishEntry();
        current = { name: line.match(/^\*\*([^*]+)/)?.[1] || "entry", lines: [line] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    finishEntry();
  }
  for (const file of referenceMd) {
    if (basename(file).includes("TEMPLATE")) continue;
    const count = linesOf(readFileSync(file, "utf-8")).length;
    if (count > policy.referenceMaxLines) add("warning", "reference_size", file, `${count} lines exceeds ${policy.referenceMaxLines}; split manually`);
  }
  for (const file of peopleMd) {
    const count = linesOf(readFileSync(file, "utf-8")).length;
    if (count > policy.peopleDetailMaxLines) add("warning", "people_size", file, `${count} lines exceeds ${policy.peopleDetailMaxLines}; review manually`);
  }

  // Stale OpenClaw Discord sessions (same cache contract as the legacy lint).
  const sessionsPath = home ? join(home, ".openclaw", "agents", "main", "sessions", "sessions.json") : null;
  const channelCachePath = home ? join(home, ".openclaw", ".channel-cache.json") : null;
  if (sessionsPath && channelCachePath && existsSync(sessionsPath) && existsSync(channelCachePath)) {
    try {
      const sessions = JSON.parse(readFileSync(sessionsPath, "utf-8"));
      const channels = JSON.parse(readFileSync(channelCachePath, "utf-8"));
      const channelIds = new Set(Object.keys(channels || {}));
      if (channelIds.size) {
        for (const key of Object.keys(sessions || {})) {
          const id = key.match(/discord:channel:(\d+)/)?.[1];
          if (id && !channelIds.has(id)) add("warning", "stale_session", sessionsPath, `${key}: channel ${id} not in cache`);
        }
      }
    } catch (err) {
      add("warning", "stale_session_read", sessionsPath, `could not parse session/cache JSON: ${err.message}`);
    }
  }

  // Summary/why contract. Accept frontmatter description as the modern form.
  const summaryFiles = [
    ...immediateMemoryMd,
    ...referenceMd,
    ...peopleMd,
    ...markdownFiles(root).filter((file) => basename(file) !== "BOOTSTRAP.md"),
  ].filter((file) => !basename(file).includes("TEMPLATE"));
  for (const file of new Set(summaryFiles)) {
    const rel = relative(root, file);
    if (ignores.has(`summary:${rel}`)) continue;
    const lines = linesOf(readFileSync(file, "utf-8"));
    if (lines[0] === "---") {
      if (!hasFrontmatterDescription(lines)) add("warning", "summary_missing", file, "frontmatter lacks description");
      continue;
    }
    if (!lines.slice(0, 3).some((line) => line.startsWith("> summary:"))) {
      add("warning", "summary_missing", file, "missing > summary: in first 3 lines");
    } else if (!lines.slice(0, 5).some((line) => line.startsWith("> why:"))) {
      add("warning", "why_missing", file, "missing > why: in first 5 lines");
    }
  }

  // Tasks and forgotten todos.
  const today = localDateKey(now);
  const tasksPath = join(memoryDir, "tasks.md");
  if (existsSync(tasksPath)) {
    let parked = false;
    for (const line of linesOf(readFileSync(tasksPath, "utf-8"))) {
      if (line.startsWith("## ")) parked = line.startsWith("## Parkerat");
      if (!line.startsWith("- [ ] ") || parked) continue;
      const deadline = line.match(/deadline: (\d{4}-\d{2}-\d{2})/)?.[1];
      if (deadline && deadline <= today) add("warning", "task_due", tasksPath, `${deadline === today ? "due today" : "overdue"}: ${line.slice(6)}`);
      else if (!deadline) add("info", "task_no_deadline", tasksPath, line.slice(6));
    }
  }
  const forgottenCutoff = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
  const forgottenKey = localDateKey(forgottenCutoff);
  for (const file of dailyFiles) {
    if (basename(file, ".md") >= forgottenKey) continue;
    const todos = linesOf(readFileSync(file, "utf-8")).filter((line) => line.startsWith("- [ ] "));
    if (todos.length) add("warning", "forgotten_todo", file, `${todos.length} unchecked todo(s)`);
  }

  // Reference-table and orphan checks.
  const memoryText = existsSync(memoryIndex) ? readFileSync(memoryIndex, "utf-8") : "";
  const peopleText = existsSync(peopleIndex) ? readFileSync(peopleIndex, "utf-8") : "";
  for (const file of peopleMd) {
    const name = basename(file);
    const relKey = `ref-table:people/${name}`;
    if (!memoryText.includes(name) && !ignores.has(relKey)) add("warning", "people_reference", file, "not listed in MEMORY.md");
    if (!memoryText.includes(name) && !peopleText.includes(name)) add("warning", "people_orphan", file, "not linked from people.md or MEMORY.md");
  }
  const allReachabilityText = [
    ...markdownFiles(root), ...immediateMemoryMd, ...referenceMd, ...peopleMd,
  ].map((file) => ({ file, text: readFileSync(file, "utf-8") }));
  for (const file of referenceMd) {
    if (basename(file).includes("TEMPLATE")) continue;
    const name = basename(file);
    const linked = allReachabilityText.some((entry) => entry.file !== file && entry.text.includes(name));
    if (!linked) add("info", "reference_unlinked", file, "not linked from another markdown file");
  }

  // Empathy radar essentials.
  for (const file of peopleMd) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes("<!-- template: empathy-radar -->")) continue;
    if (!/verktyg för självförståelse|fingervisning|inte en diagnos/i.test(text)) add("warning", "radar_disclaimer", file, "missing empathy-radar disclaimer");
    if (!/mappning:/i.test(text)) add("warning", "radar_mapping", file, "missing empathy-radar mapping");
    for (let i = 1; i <= 8; i++) {
      const row = text.split(/\r?\n/).find((line) => line.startsWith(`| ${i} |`));
      if (!row || !/[✅❌❓]/u.test(row)) add("warning", "radar_answer", file, `observation ${i} lacks answer`);
    }
  }

  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.length - warningCount;
  const todayPath = join(memoryDir, `${today}.md`);
  const dream = existsSync(todayPath) ? latestDreamSentinel(readFileSync(todayPath, "utf-8")) : null;
  return {
    workspace: root,
    policy,
    findings,
    compactable: compactable.sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
    summary: { warnings: warningCount, info: infoCount, compactable: compactable.length },
    dream,
  };
}

export function formatMemoryLint(result) {
  const rows = [`Memory lint: ${result.summary.warnings} warning(s), ${result.summary.info} info, ${result.summary.compactable} compactable`];
  for (const finding of result.findings) {
    const icon = finding.severity === "warning" ? "WARN" : "INFO";
    rows.push(`${icon} ${finding.code}${finding.file ? ` ${finding.file}` : ""}: ${finding.message}`);
  }
  if (!result.findings.length) rows.push("OK all clean");
  return rows.join("\n");
}

export function formatMemoryStatus(result) {
  const rows = [
    `Memory status: ${result.summary.warnings} warning(s), ${result.summary.compactable} compactable daily file(s)`,
    `Workspace: ${result.workspace}`,
  ];
  if (result.compactable.length) {
    const oldest = result.compactable[0];
    rows.push(`Backlog oldest: ${oldest.dateKey} (${oldest.lines} lines -> ~${oldest.targetLines} content lines)`);
  } else {
    rows.push("Backlog: empty");
  }
  if (result.dream) rows.push(`Latest dream: ${result.dream.date} ${result.dream.time}, ${result.dream.ok} ok / ${result.dream.failed} failed`);
  else rows.push("Latest dream: no sentinel in today's file");
  if (result.compact) rows.push(`Latest compact: ${result.compact.date} ${result.compact.hash.slice(0, 12)} (${result.compact.subject})`);
  else rows.push("Latest compact: none");
  return rows.join("\n");
}

export function readLatestMemoryCompact(workspace) {
  const result = spawnSync("git", [
    "log", "-1", "--format=%H%x09%cI%x09%s", "--grep=^chore(memory): compact",
  ], { cwd: workspace, encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const [hash, date, subject] = result.stdout.trim().split("\t");
  return hash && date ? { hash, date, subject: subject || "memory compact" } : null;
}

export function writeMemoryDailyReport(workspace, result, { compacted = 0, now = new Date() } = {}) {
  const dateKey = localDateKey(now);
  const path = join(workspace, "memory", `${dateKey}.md`);
  if (!existsSync(path)) throw new Error(`${path}: daily file missing; run amux dream first`);
  const marker = `<!-- amux-memory-status:${dateKey} -->`;
  const line = `- memory: ${result.summary.warnings} varning(ar), backlog ${result.summary.compactable} fil(er), komprimerade ${compacted} inatt.`;
  const blockRe = new RegExp(`\\n?<!-- amux-memory-status:${dateKey} -->\\n[^\\n]*\\n?`, "g");
  const content = readFileSync(path, "utf-8").replace(blockRe, "\n").trimEnd();
  writeFileSync(path, `${content}\n\n${marker}\n${line}\n`);
  return { path, line };
}
