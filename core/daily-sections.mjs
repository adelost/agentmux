// `## ` sections of a daily memory note, counted the way writers are told to count them.

const linesOf = (text) => {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * WHAT: Parses a daily note into `## ` sections with line ranges and written-line counts.
 * WHY: Keeps lint and the write-time reminder from counting a section differently; blank and comment lines are not writing.
 */
export function dailySections(text) {
  const lines = linesOf(text);
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      if (current) sections.push({ ...current, end: index });
      current = { heading: line.slice(3).trim(), start: index, lines: 0 };
    } else if (current && line.trim() && !line.startsWith("<!--")) {
      current.lines += 1;
    }
  });
  if (current) sections.push({ ...current, end: lines.length });
  return sections;
}

/** WHAT: Returns the section holding a line index. WHY: Keeps an edit on the section its new text landed in instead of the file's last one. */
export function sectionAtLine(sections, lineIndex) {
  return sections.find((section) => lineIndex >= section.start && lineIndex < section.end) || null;
}
