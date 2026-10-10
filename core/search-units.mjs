// Retrieval units for memory Markdown. Notes are written as headed sections
// of bullets, person entries and table rows; an answer is usually one such
// item. Packing several items into one fixed-size chunk let a long neighbour
// outweigh the answer and buried short entries ("**Axel** — systerson") under
// unrelated text (golden eval 2026-10-10: people hit@3 50 %). Each unit keeps
// its heading path, so a bullet still carries the section it belongs to.

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/u;
const LIST_ITEM = /^(?:[-*+]|\d{1,3}[.)])\s+\S/u;
const ENTRY = /^\*\*[^*\n]{1,80}\*\*/u;
const TABLE_ROW = /^\|.*\|\s*$/u;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|\s*$/u;
const COMMENT = /^<!--.*-->\s*$/u;
const MAX_UNIT_CHARS = 1600;
const MIN_UNIT_CHARS = 8;

const startsUnit = (line) => LIST_ITEM.test(line) || ENTRY.test(line) || TABLE_ROW.test(line);

/**
 * WHAT: Parses Markdown into item units with offsets, headings and entry names.
 * WHY: Keeps a short answering bullet from drowning in neighbours packed into its chunk.
 */
export function markdownUnits(text, { maxChars = MAX_UNIT_CHARS } = {}) {
  const units = [];
  const headings = [];
  let current = null;
  let entry = null;
  let tableHeader = null;
  let inTable = false;
  let sectionStart = 0;
  let offset = 0;

  const flush = () => {
    if (!current) return;
    const body = text.slice(current.start, current.end);
    if (body.replace(/\s+/gu, "").length >= MIN_UNIT_CHARS) {
      for (const piece of splitLong(body, current.start, current.line, maxChars)) {
        units.push({ ...piece, headings: [...current.headings], sectionStart: current.sectionStart,
          ...(current.entry ? { entry: current.entry } : {}), ...(current.tableHeader ? { tableHeader: current.tableHeader } : {}) });
      }
    }
    current = null;
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      sectionStart = start;
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].replace(/<!--.*?-->/gu, "").trim();
      entry = null;
      continue;
    }
    // A table row means little without its column names ("| Claude … |
    // `account-profiles/claude/wetterlind` |" answers "vilken mapp"), so rows
    // carry the header row the way bullets carry their heading.
    const row = TABLE_ROW.test(line) && !TABLE_SEPARATOR.test(line);
    if (row && !inTable) tableHeader = line.replace(/\|/gu, " ").replace(/\s+/gu, " ").trim();
    if (!TABLE_ROW.test(line)) { inTable = false; tableHeader = line.trim() ? null : tableHeader; }
    else inTable = true;
    if (!line.trim() || COMMENT.test(line) || TABLE_SEPARATOR.test(line)) {
      // A blank line ends a paragraph. After a list item only an indented
      // line continues it; unindented text starts a new unit.
      if (!line.trim() && current) {
        if (current.item) current.open = false;
        else flush();
      }
      continue;
    }
    const indented = /^\s/u.test(line);
    if (startsUnit(line) || !current || (current.item && !current.open && !indented)) {
      flush();
      // A person or term entry ("**Name** — …") is the subject of the bullets
      // under it, the way a heading is for a section.
      const name = line.match(ENTRY)?.[0].slice(2, -2).trim();
      if (name) entry = name;
      const header = row && tableHeader && line.replace(/\|/gu, " ").replace(/\s+/gu, " ").trim() !== tableHeader ? tableHeader : null;
      current = { start, end, line: index + 1, item: startsUnit(line), open: true,
        headings: headings.filter(Boolean), entry: name ? null : entry, sectionStart, tableHeader: header };
      continue;
    }
    current.end = end;
  }
  flush();
  // A section runs from its heading to the next heading of any level.
  const starts = [...new Set(units.map(unit => unit.sectionStart))].sort((a, b) => a - b);
  const next = new Map();
  const boundaries = [...text.matchAll(/^#{1,4}\s/gmu)].map(match => match.index);
  for (const value of starts) next.set(value, boundaries.find(at => at > value) ?? text.length);
  return units.map(({ sectionStart: from, ...unit }) => ({ ...unit, section: { start: from, end: next.get(from) } }));
}

function splitLong(body, start, line, maxChars) {
  if (body.length <= maxChars) return [{ start, length: body.length, line, text: body }];
  const pieces = [];
  let pieceStart = 0;
  let pieceLine = line;
  let cursor = 0;
  let lineNo = line;
  for (const row of body.split("\n")) {
    const rowEnd = cursor + row.length;
    if (rowEnd - pieceStart > maxChars && cursor > pieceStart) {
      pieces.push({ start: start + pieceStart, length: cursor - 1 - pieceStart, line: pieceLine,
        text: body.slice(pieceStart, cursor - 1) });
      pieceStart = cursor;
      pieceLine = lineNo;
    }
    cursor = rowEnd + 1;
    lineNo++;
  }
  const rest = body.slice(pieceStart);
  for (let at = 0; at < rest.length; at += maxChars) {
    // A single line longer than the cap is cut at the cap, never dropped.
    pieces.push({ start: start + pieceStart + at, length: Math.min(maxChars, rest.length - at),
      line: pieceLine, text: rest.slice(at, at + maxChars) });
  }
  return pieces;
}
