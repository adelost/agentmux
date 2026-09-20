import { inspectTopics } from "../core/memory-topics.mjs";
import { publishMemoryTopic } from "../core/memory-topic-publish.mjs";

/** WHAT: Routes topic inspection and publication. WHY: Keeps status and search on the same evidence policy without waking an agent. */
export function cmdMemoryTopics(workspace, flags = {}) {
  if (flags.publish) {
    const result = publishMemoryTopic(workspace, flags.publish);
    console.log(flags.json ? JSON.stringify(result, null, 2) : `${result.changed ? "Published" : "Unchanged"} ${result.path} ${result.state} ${result.sha256}`);
    return;
  }
  const topics = inspectTopics(workspace);
  const view = topics.map(({ meta, path, state, cell, facts, reason, sources }) => ({ id: meta?.id, path, state, cell, facts, reason, sources }));
  console.log(flags.json ? JSON.stringify(view, null, 2) : topics.length
    ? view.map(row => `${row.state} ${row.id || row.path} · ${row.cell}${row.reason ? ` · ${row.reason}` : ""}`).join("\n")
    : "No topic notes. Publish a source-bound Markdown note with amux memory topics --publish FILE.");
}
