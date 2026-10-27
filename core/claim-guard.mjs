import { createClaimSources } from "./claim-sources.mjs";

const UNCERTAIN = /(?:inte kontrollerat|inte kontrollerad|antagande|assumption|unverified|not checked)/iu;
const PLAN = /^(?:NEXT|GOAL|LEFT|Förslag|Plan|Rekommendation)\s*:|^(?:jag|vi)\s+(?:ska|kommer att|vill)\b/iu;
const DOMAIN = /(?:kod|fil(?:en|er|erna)?\b|repo|test|prov|kvot|kont[oen]|nyck|token|key|quota|account|service|tjänst|worker|runtime|gateway|live|release|släpp|deploy|version|utcheckning|Quick|export|kostnad|budget|USD|grön|röd|pass|fail|git|käll|server|logg|modell)/iu;
const ASSERTION = /(?<![\p{L}\d_])(?:är|var|har|hade|finns|saknas|fick|gav|blev|blivit|ligger|kom|tog|gick|kör|visar|visade|kräver|behöver|hittade|kan vara|is|are|was|were|has|have|passed|failed|exists|deployed|returned)(?![\p{L}\d_])/iu;
const CAUSE = /\b(?:eftersom|orsak|beror på|because|caused)\b/iu;
const DENIAL = /\b(?:ingen|inget|inga|saknas|saknad|finns inte|hittade (?:jag )?inte|does not exist|not found|no (?:file|test|version|key|account))\b/iu;
const SEARCH = /\b(?:rg|git\s+grep|find)\s/iu;
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
    } else for (const path of m[1].matchAll(pathPattern)) addPath(path);
  }
  // Unquoted file:line and artifact receipts are supported, bare filename words are not sources.
  for (const m of text.matchAll(pathPattern)) if (m[1] || m[0].includes(".artifacts/")) addPath(m);
  for (const m of text.matchAll(SHA)) sources.push({ kind: "sha", value: m[0] });
  return sources;
}

/** WHAT: Checks factual assertions for valid citations. WHY: Keeps CLI and live mirrors on one heuristic without certifying factual truth. */
export function checkReply(text, repos = []) {
  const resolver = typeof repos?.validate === "function" ? repos : createClaimSources(repos);
  const sentences = [];
  let claims = 0;
  for (const unit of unitsOf(String(text || ""))) {
    if (PLAN.test(unit) || UNCERTAIN.test(unit) || unit.endsWith("?")) continue;
    if (!(CAUSE.test(unit) || (DOMAIN.test(unit) && ASSERTION.test(unit)))) continue;
    claims += 1;
    const sources = sourcesOf(unit, text);
    const valid = sources.filter(source => resolver.validate(source));
    if (DENIAL.test(unit)) {
      const scopedSearch = valid.some(source => source.kind === "command" && SEARCH.test(source.value)
        && /(?:\/|\bHEAD\b|--tree|--work-tree)/u.test(source.value)
        && /\b[a-f\d]{7,40}\b/iu.test(unit));
      if (!scopedSearch) sentences.push({ text: unit, why: "denial-needs-search-tree-and-sha" });
    } else if (!valid.length) sentences.push({ text: unit, why: sources.length ? "source-invalid-or-output-missing" : "source-missing" });
  }
  return { verdict: sentences.length ? "hold" : "pass", sentences, claims };
}
