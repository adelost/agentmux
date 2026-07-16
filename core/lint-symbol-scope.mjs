/**
 * WHAT: Maps changed target lines to the public symbols that own those lines.
 * WHY: Keeps changed-mode contract lint from reopening untouched legacy functions in edited files.
 */

function regexCanStart(line, index) {
  let previous = index - 1;
  while (previous >= 0 && /[ \t]/.test(line[previous])) previous -= 1;
  if (previous < 0 || /[=(:,!&|?{};\[\]]/.test(line[previous])) return true;
  return /(?:\breturn|\bthrow|\bcase|=>)\s*$/.test(line.slice(0, index));
}

function cfamilyLeadingLine(lines, declaration) {
  let index = declaration - 1;
  while (index >= 0 && /^\s*@/.test(lines[index])) index -= 1;
  if (index < 0) return declaration + 1;
  if (lines[index].trim().endsWith("*/")) {
    while (index > 0 && !lines[index].trim().startsWith("/*")) index -= 1;
    return index + 1;
  }
  while (index >= 0 && /^\s*\/\//.test(lines[index])) index -= 1;
  return index + 2;
}

function cfamilyEndLine(lines, declaration) {
  let blockComment = false;
  let quote = null;
  let regex = false;
  let regexClass = false;
  let opened = false;
  let depth = 0;
  for (let lineIndex = declaration; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (blockComment) {
        if (char === "*" && next === "/") { blockComment = false; index += 1; }
        continue;
      }
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (regex) {
        if (char === "\\") index += 1;
        else if (char === "[") regexClass = true;
        else if (char === "]") regexClass = false;
        else if (char === "/" && !regexClass) regex = false;
        continue;
      }
      if (char === "/" && next === "/") break;
      if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
      if (char === "/" && regexCanStart(line, index)) { regex = true; regexClass = false; continue; }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "{") { opened = true; depth += 1; }
      else if (char === "}" && opened && --depth === 0) return lineIndex + 1;
      else if (char === ";" && !opened) return lineIndex + 1;
    }
    if (quote !== "`") quote = null;
    regex = false;
  }
  return declaration + 1;
}

function pythonLeadingLine(lines, declaration) {
  let index = declaration - 1;
  while (index >= 0 && /^@/.test(lines[index])) index -= 1;
  return index + 2;
}

function pythonEndLine(lines, declaration) {
  let end = declaration + 1;
  for (let index = declaration + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !/^\s/.test(line)) break;
    end = index + 1;
  }
  return end;
}

function ownsChangedLine(changedLines, start, end) {
  for (const line of changedLines) if (line >= start && line <= end) return true;
  return false;
}

/**
 * WHAT: Filters public symbols to declarations, docs, or bodies intersecting added target lines.
 * WHY: Keeps contract enforcement focused on behavior a branch actually touched.
 */
export function changedSymbols(source, ext, symbols, changedLines) {
  if (!changedLines) return symbols;
  const lines = source.split(/\r?\n/);
  const python = ext === ".py";
  return symbols.filter((symbol) => {
    const declaration = symbol.line - 1;
    const start = python ? pythonLeadingLine(lines, declaration) : cfamilyLeadingLine(lines, declaration);
    const end = python ? pythonEndLine(lines, declaration) : cfamilyEndLine(lines, declaration);
    return ownsChangedLine(changedLines, start, end);
  });
}
