/** WHAT: Returns source-config coding panes with physical indices. WHY: Keeps every coding engine contiguous before services and shells. */
export function sourceCodingPaneSlots(config) {
  const slots = [];
  let index = 0;
  const claudeCount = config.claudeCount ?? config.panes ?? 0;
  const codexCount = config.codexCount ?? Math.max(0, (config.panes ?? 0) - claudeCount);
  for (const [engine, count] of [
    ["claude", claudeCount],
    ["codex", codexCount],
    ["kimi", config.kimiCount || 0],
    ["qwen", config.qwenCount || 0],
  ]) {
    for (let ordinal = 0; ordinal < count; ordinal++) slots.push({ pane: index++, engine, ordinal });
  }
  return slots;
}

/** WHAT: Resolves one physical coding pane. WHY: Keeps sparse coding positions out of range arithmetic. */
export const sourcePaneSlot = (config, pane) =>
  sourceCodingPaneSlots(config).find((slot) => slot.pane === Number(pane)) || null;

/** WHAT: Resolves one physical pane dialect. WHY: Keeps channel and migration routing on the same pane plan. */
export const sourcePaneDialect = (config, pane) => sourcePaneSlot(config, pane)?.engine || null;

/** WHAT: Builds one coding-pane channel name. WHY: Keeps non-Claude suffixes separate from physical index allocation. */
export function sourcePaneChannelName(name, pane, config) {
  const dialect = sourcePaneDialect(config, pane);
  return dialect === "claude" ? `${name}-${pane}` : `${name}-${pane}-${dialect}`;
}

/** WHAT: Builds Discord names from actual coding slots. WHY: Prevents channel routing from duplicating engine-order arithmetic. */
export function generateSourceChannelNames(agents) {
  const result = [];
  for (const name of [...agents.keys()].sort()) {
    const config = agents.get(name);
    for (const { pane, engine } of sourceCodingPaneSlots(config)) {
      result.push({ agentName: name, channelName: sourcePaneChannelName(name, pane, config), pane, dialect: engine });
    }
  }
  return result;
}
