/** WHAT: Checks native completed Codex compaction boundaries. WHY: Keeps compact verification, resume and maintenance fences on one engine contract. */
export const isCodexCompaction = event => event?.type === "compacted"
  || (event?.type === "event_msg" && (event.payload?.type === "context_compacted"
    || (event.payload?.type === "item_completed" && event.payload.item?.type === "ContextCompaction"
      && typeof event.payload.item.id === "string" && event.payload.item.id.length > 0)));
