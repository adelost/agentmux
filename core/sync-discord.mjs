// Discord API orchestrator for /sync. Wires pure sync logic to real API calls.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { ChannelType } from "discord.js";
import { parseConfig, generateChannelNames, buildSyncPlan, generateAgentsYaml } from "../sync.mjs";

/**
 * Execute a full sync: read config, create Discord channels, generate agents.yaml.
 * @param {{ guild: object, configYaml: string, state: object, agentsYamlPath: string }} opts
 * @returns {{ created: string[], existing: string[], orphaned: string[] }}
 */
export async function executeSync({ guild, configYaml, state, agentsYamlPath }) {
  // Check permissions
  const me = await guild.members.fetchMe();
  if (!me.permissions.has("ManageChannels")) {
    throw new Error("Bot needs ManageChannels permission. Update bot permissions in Discord Developer Portal → OAuth2 → Bot Permissions.");
  }

  const config = parseConfig(configYaml);
  const desired = generateChannelNames(config.agents);

  // Find or create category
  const allChannels = await guild.channels.fetch();
  let category = allChannels.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === config.category.toLowerCase(),
  );
  if (!category) {
    category = await guild.channels.create({ name: config.category, type: ChannelType.GuildCategory });
  }

  // Get existing channels in category
  const existingInCategory = allChannels
    .filter((ch) => ch.parentId === category.id && ch.type === ChannelType.GuildText)
    .map((ch) => ({ name: ch.name, id: ch.id }));

  // Build plan
  const plan = buildSyncPlan(desired, existingInCategory);

  // Create missing channels (sequentially to avoid rate limits)
  const created = [];
  for (const ch of plan.toCreate) {
    const newCh = await guild.channels.create({
      name: ch.channelName,
      type: ChannelType.GuildText,
      parent: category.id,
    });
    created.push({ ...ch, id: newCh.id });
  }

  // Build full channel mapping: channelName → channelId
  const channelMap = new Map();
  for (const ch of plan.existing) channelMap.set(ch.channelName, ch.id);
  for (const ch of created) channelMap.set(ch.channelName, ch.id);

  // Set channel positions (grouped by agent, alphabetical)
  const allSynced = [...plan.existing, ...created].sort((a, b) => {
    if (a.agentName !== b.agentName) return a.agentName.localeCompare(b.agentName);
    return a.pane - b.pane;
  });
  for (let i = 0; i < allSynced.length; i++) {
    try {
      const ch = await guild.channels.fetch(allSynced[i].id);
      await ch.setPosition(i);
    } catch {}
  }

  // Generate or reuse session UUIDs
  const prevSync = state.get("sync", {});
  const prevAgents = prevSync.agents || {};
  const agentIds = new Map();
  for (const name of config.agents.keys()) {
    agentIds.set(name, prevAgents[name]?.id || randomUUID());
  }

  // Save to state
  const syncState = {
    channels: Object.fromEntries(channelMap),
    agents: Object.fromEntries([...config.agents.keys()].map((name) => [name, { id: agentIds.get(name) }])),
  };
  state.set("sync", syncState);

  // Generate and write agents.yaml
  const yamlContent = generateAgentsYaml(config.agents, channelMap, agentIds);
  mkdirSync(dirname(agentsYamlPath), { recursive: true });
  writeFileSync(agentsYamlPath, yamlContent);

  return {
    created: created.map((ch) => `#${ch.channelName}`),
    existing: plan.existing.map((ch) => `#${ch.channelName}`),
    orphaned: plan.orphaned.map((ch) => `#${ch.name}`),
  };
}
