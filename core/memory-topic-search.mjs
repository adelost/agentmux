import { resolve, sep } from "node:path";
import { inspectTopic, inspectTopics, topicDirectory } from "./memory-topics.mjs";

const STOP = new Set("a an and are as att av blev blir de den det do du då eller en ett får för från ha hade har hela hur i in inte jag kan man med mig och of om on på sig ska som the till to vad var vi vilken vilket varför är att efter before is it does have when where why who".split(" "));
const words = text => (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length > 1 && !STOP.has(word));
const ENDINGS = new Set(["s", "n", "en", "et", "er", "or", "ar", "na", "ens", "ets", "erna", "arna", "orna", "ed", "ing"]);
const sameWord = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short) && ENDINGS.has(long.slice(short.length));
};

/** WHAT: Checks whether a path belongs to the derived topic subtree. WHY: Prevents ordinary lexical or semantic paths from bypassing topic validation. */
export const isTopicPath = (path, workspace) => resolve(path).startsWith(`${topicDirectory(workspace)}${sep}`);

/** WHAT: Returns eligible topics ranked for a real query. WHY: Keeps derived context separate from original decision authority. */
export function searchMemoryTopics(query, workspace, { topics = inspectTopics(workspace) } = {}) {
  const terms = [...new Set(words(query))];
  if (!terms.length) return { hits: [], excluded: [] };
  const docs = topics.filter(topic => topic.meta).map(topic => ({ topic,
    terms: words(`${topic.meta.title} ${topic.meta.summary} ${topic.meta.aliases.join(" ")} ${topic.body}`),
    labels: words(`${topic.meta.title} ${topic.meta.aliases.join(" ")}`) }));
  const average = docs.reduce((n, doc) => n + doc.terms.length, 0) / Math.max(1, docs.length);
  const candidates = docs.map(doc => {
    let score = 0;
    let matches = 0;
    for (const term of terms) {
      const tf = doc.terms.filter(token => sameWord(term, token)).length;
      if (!tf) continue;
      matches++;
      const df = docs.filter(other => other.terms.some(token => sameWord(term, token))).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.terms.length / Math.max(1, average)));
      if (doc.labels.some(token => sameWord(term, token))) score += idf;
    }
    return { ...doc.topic, score, matches };
  }).filter(doc => doc.matches >= Math.min(2, terms.length)).sort((a, b) => b.score - a.score || a.meta.id.localeCompare(b.meta.id));
  return {
    hits: candidates.filter(topic => topic.action === "SERVE").map(topic => ({
      path: topic.path, line: 1, root: "memory-topics", layer: "topic", score: topic.score,
      date: topic.meta.asOf, snippet: `${topic.meta.title}: ${topic.meta.summary}`,
      topic: { workspace: resolve(workspace), id: topic.meta.id, sha256: topic.sha256, state: topic.state, cell: topic.cell },
    })),
    excluded: [...candidates.filter(topic => topic.action !== "SERVE").map(topic => ({ id: topic.meta.id, state: topic.state, cell: topic.cell })),
      ...topics.filter(topic => !topic.meta).map(topic => ({ id: topic.path, state: topic.state, cell: topic.cell }))],
  };
}

/** WHAT: Returns topic orientation alongside original-source results. WHY: Keeps original evidence available beside derived context. */
export function mergeTopicHits(original, topics, max = 12) {
  const count = Math.max(1, Number(max) || 12);
  const leading = topics.slice(0, original.length && count > 1 ? Math.min(2, count - 1) : Math.min(2, count));
  return [...leading, ...original, ...topics.slice(leading.length)].slice(0, count);
}

/** WHAT: Checks and expands a saved topic. WHY: Prevents --show from replaying a summary after its source or page changes. */
export function expandMemoryTopic(hit) {
  if (!hit.topic || !isTopicPath(hit.path, hit.topic.workspace)) return "Topic reference invalid; repeat the search.";
  const current = inspectTopic(hit.topic.workspace, hit.path);
  if (current.action !== "SERVE" || current.sha256 !== hit.topic.sha256) {
    return `Topic unavailable: ${current.state}; page/source changed since search. Use original sources or repeat search.\n`
      + (current.sources || []).map(source => `${source.path}:${source.from}`).join("\n");
  }
  return [`[derived topic ${current.meta.id}; ${current.state}; asOf ${current.meta.asOf}; cell ${current.cell}]`,
    "Source hashes match. This is orientation, not proof that no later decision exists.", current.body,
    "Original evidence:", ...current.sources.map(source => `${source.path}:${source.from}-${source.to} sha256 ${source.sha256}`),
  ].join("\n\n");
}
