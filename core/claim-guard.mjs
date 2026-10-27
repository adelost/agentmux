import { createClaimSources } from "./claim-sources.mjs";

const UNCERTAIN = /(?:inte kontrollerat|inte kontrollerad|antagande|assumption|unverified|not checked|oprövad[et]?|inte (?:prövat|testat|kört)|ej verifierat)/iu;
const PLAN = /^(?:NEXT|GOAL|LEFT|Förslag|Plan|Rekommendation)\s*:|^(?:Nästa|Next|Om|If)\s|^Finns\s.+\b(?:startar|väntar|ska|kommer)\b|^Det räcker (?:därför |att )|^(?:jag|vi)\s+(?:ska|kommer att|vill)\b/iu;
const REQUEST = /(?:\b(?:kan|vill|behöver|måste) du\s+(?:köra|godkänna|besluta|välja|lägga|klistra|logga|skicka)|\bdu\s+(?:behöver|måste|ska)\s+(?:köra|godkänna|besluta|välja|lägga|klistra|logga)|\bdu har\b.{0,50}\b(?:nycklar?|token)\b.{0,30}\b(?:lägga|klistra|skicka)|^NEXT:\s*(?:din(?:a)?\b.{0,40}(?:nyck|token)|säg ja|godkänn|besluta|kör\b|klistra)|^(?:Mattias[, :]+)?(?:kör|godkänn|bekräfta|klistra in|lägg in)\b)/iu;
const STATE = /(?:(?<![\p{L}\d_])(?:är|var|ligger|blev|blivit)\s+(?:(?:nu|redan|fortfarande|inte|ännu|kvar|också|alltså|helt|både)\s+){0,3}(?:live|släppt|driftsatt|rättat|fixat|trasig)|\b(?:har|hade)\s+(?:nu\s+|redan\s+)?(?:släppt|rättat|fixat)|\b(?:släppt|släppte|deployed)\b.{0,70}\blive\b|\b(?:fungerar|drabbar)\b|\b(?:påverkar|trasig|bruten)\b.{0,50}\b(?:användare|users)\b|\bgår (?:inte )?att använda\b|\b(?:is|was)\s+(?:live|deployed|fixed|broken)|\b(?:affects users|works|does not work)\b)/iu;
const CAUSE = /(?:\borsaken?\s+(?:är|var)|\bberor på(?=\s|[.,:;])|\bkommer från\b|\b(?:root cause is|caused by)\b|\b(?:eftersom|because)\b)/iu;
const TECHNICAL = /(?:fel(?:et)?\b|bug|kod|klient|läsar|konto|logga|version|runtime|gateway|live|export|cache|worker|token|nyck|service|tjänst)/iu;
const INVESTIGATION = /^(?:(?:SUMMARY|NOW):\s*)?(?:jag|vi)\s+(?:undersöker|utreder|kontrollerar|väljer|väntar|avstår|föreslår)\b/iu;
const EVIDENCE_PATH = /(?:\.artifacts\/|(?:receipt|kvitto|logg?|response|saved[-_]?(?:reply|answer)|sparat[-_]?svar)[^/]*\.(?:jsonl?|log|txt|md)|\.log$)/iu;
const SHA = /\b[a-f\d]{7,40}\b/giu;
const OUTPUT = /(?:utdata|output|resultat|exit(?:Code)?\s*[:=]|\b\d+\s+(?:träffar|matches|passed|gröna)|```[^`]*```)/iu;

function unitsOf(text) {
  const units = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/u.test(line)) { fence = !fence; continue; }
    if (fence || !line.trim()) continue;
    const content = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "").replace(/\*\*/gu, "").trim();
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)) units.push(content);
    else {
      const protectedText = [];
      const safe = content.replace(/`[^`]*`|https?:\/\/[^\s<>]+/gu, part => `§${protectedText.push(part) - 1}§`);
      units.push(...safe.split(/(?<=[.!?])\s+/u).map(part => part.replace(/§(\d+)§/gu, (_, n) => protectedText[n])));
    }
  }
  return units;
}

function sourcesOf(text, reply) {
  const sources = [];
  const pathPattern = /(?:~\/|\/|\.\.?\/)?[\w@.-]+(?:\/[\w@ .-]+)*\.[a-z\d]{1,12}(?::(\d+)(?:-\d+)?)?/giu;
  const addPath = match => {
    const raw = match[0].replace(/[.,;]$/u, "");
    const line = /:(\d+)(?:-\d+)?$/u.exec(raw);
    sources.push({ kind: "path", value: raw.replace(/:\d+(?:-\d+)?$/u, ""), ...(line ? { line: Number(line[1]) } : {}) });
  };
  for (const m of text.matchAll(/https?:\/\/[^\s<>`]+/giu)) sources.push({ kind: "url", value: m[0] });
  for (const m of text.matchAll(/\bdelivery:[a-f\d]{16,64}\b/giu)) sources.push({ kind: "delivery", value: m[0] });
  for (const m of text.matchAll(/`([^`\n]+)`/gu)) {
    if (/^(?:amux|ax|git|rg|find|node|npm|npx|python\d?|curl|ls|stat|cat|test|wc)\s/u.test(m[1])) {
      if (OUTPUT.test(reply)) sources.push({ kind: "command", value: m[1] });
    } else if (/^(?:~\/|\/|\.\.?\/)?[\w@.-]+(?:\/[\w@.-]+)+$/u.test(m[1])) {
      sources.push({ kind: "path", value: m[1] });
    } else for (const path of m[1].matchAll(pathPattern)) addPath(path);
  }
  // Unquoted file:line and artifact receipts are supported, bare filename words are not sources.
  for (const m of text.matchAll(pathPattern)) if (m[1] || m[0].includes(".artifacts/")) addPath(m);
  for (const m of text.matchAll(SHA)) sources.push({ kind: "sha", value: m[0] });
  return sources;
}

function claimClass(unit) {
  // A request to the human still needs justification when written under NEXT or as a question.
  if (REQUEST.test(unit)) return "human-request";
  if (PLAN.test(unit) || UNCERTAIN.test(unit) || INVESTIGATION.test(unit) || unit.endsWith("?")) return null;
  if (CAUSE.test(unit) && TECHNICAL.test(unit)) return "technical-cause";
  return STATE.test(unit) ? "operational-state" : null;
}

function isEvidence(source) {
  return source.kind === "command" || source.kind === "path" && (source.line || EVIDENCE_PATH.test(source.value))
    || source.kind === "url" && /(?:\.artifacts\/|\/(?:receipts?|logs?|responses?)\/)/iu.test(source.value);
}

/** WHAT: Checks the first visible mention of known task IDs and explicit PR/ticket references. WHY: Numbers need a nearby name without treating measurements as tasks. */
export function checkTaskNames(text, taskNumbers = []) {
  const known = new Set(taskNumbers), seen = new Set(), bare = [];
  const mask = match => " ".repeat(match.length);
  const visible = String(text).replace(/```[\s\S]*?```|https?:\/\/[^\s<>]+|`(?!\d+[a-z]?`)[^`\n]*`/giu, mask)
    .replace(/(?:[\w.-]+\/)*[\w.-]+\.[a-z]+:\d+(?:-\d+)?|\b[a-f\d]{7,40}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d+\/\d+\b|\b\d+[.,]\d+\b/giu, mask);
  for (const match of visible.matchAll(/(?<![\p{L}\d_])#?(\d+[a-z]?)(?![\p{L}\d_])/giu)) {
    const id = match[1], before = visible.slice(Math.max(0, match.index - 24), match.index);
    const after = visible.slice(match.index + match[0].length);
    const explicit = /(?:rad|row|PR|ticket|task|uppgift)\s*[:#]?\s*$/iu.test(before) || match[0].startsWith("#");
    if (!explicit && (!known.has(id) || !/^\d{3,}[a-z]?$|^\d+[a-z]$/iu.test(id)
      || /(?:släpp|release|version|build|bundle)\s*#?\s*$/iu.test(before))) continue;
    if (!explicit && (/^(?:19|20)\d{2}$/u.test(id) || /^\s*(?:%|px\b|USD\b|kr\b|ms\b|s\b|min\b|h\b|MB\b|KB\b|prov\b|tester\b|svar\b|repliker\b|filer\b|commits\b|krediter\b)/iu.test(after))) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = /^`?\s*\(([^)\n]+)\)/u.exec(after)?.[1]
      || /^`?\s*,\s*([^,.;:\n]+)/u.exec(after)?.[1];
    const words = label?.trim().match(/[\p{L}][\p{L}'’-]*/gu) || [];
    if (words.length < 2 || words.length > 4) bare.push({ number: id, at: match.index, text: id, why: "task-name-missing" });
  }
  return { verdict: bare.length ? "hold" : "pass", sentences: bare, mentions: seen.size };
}

/** WHAT: Checks only human requests, operational state and technical causes. WHY: Prevents routine facts from bouncing replies back to their authors. */
export function checkReply(text, repos = []) {
  const resolver = typeof repos?.validate === "function" ? repos : createClaimSources(repos);
  const sentences = [];
  let claims = 0;
  text = String(text || "");
  const units = unitsOf(text);
  // A dedicated evidence line belongs to the reply; unrelated citations remain local to their unit.
  const shared = units.filter(unit => /^(?:Kvitto|Receipt|Logg?|Saved response|Sparat svar)\s*:/iu.test(unit))
    .flatMap(unit => sourcesOf(unit, text)).filter(isEvidence).filter(source => resolver.validate(source));
  for (const unit of units) {
    const category = claimClass(unit);
    if (!category) continue;
    claims += 1;
    const sources = sourcesOf(unit, text).filter(isEvidence);
    const valid = sources.filter(source => resolver.validate(source));
    if (!valid.length && !shared.length) sentences.push({ text: unit, category,
      why: sources.length ? "source-invalid-or-output-missing" : "source-missing" });
  }
  return { verdict: sentences.length ? "hold" : "pass", sentences, claims,
    names: checkTaskNames(text, resolver.taskNumbers?.() || []) };
}
