// Discord API orchestrator for /sync. Wires pure sync logic to real API calls.
//
// Layout: each agent gets its own Discord category (e.g. "ai") containing
// 0-indexed text channels (ai-0, ai-1, ai-2...) that map 1:1 to tmux pane indexes.
//
// Migration: detects legacy-named channels (#claw, #claw-2, #claw-3) and renames
// them in-place to the new format (#claw-0, #claw-1, #claw-2), preserving
// message history. Renames go in pane-ascending order to avoid name collisions.

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { ChannelType } from "discord.js";
import { parseConfig, buildMigrationPlan, generateAgentsYaml } from "../sync.mjs";

/**
 * Execute a full sync: read config, create Discord channels, generate agents.yaml.
 * @param {{ guild: object, configYaml: string, state: object, agentsYamlPath: string }} opts
 * @returns {{ created: string[], renamed: string[], existing: string[], orphaned: string[] }}
 */
export async function executeSync({ guild, configYaml, state, agentsYamlPath }) {
  const me = await guild.members.fetchMe();
  if (!me.permissions.has("ManageChannels")) {
    throw new Error("Bot needs ManageChannels permission. Update bot permissions in Discord Developer Portal → OAuth2 → Bot Permissions.");
  }

  const config = parseConfig(configYaml);
  const agentNames = [...config.agents.keys()];

  const allChannels = await guild.channels.fetch();
  const textChannels = [...allChannels.values()]
    .filter((ch) => ch && ch.type === ChannelType.GuildText)
    .map((ch) => ({ name: ch.name, id: ch.id, parentId: ch.parentId }));

  // Per-agent categories (find or create, one per agent name)
  const categories = new Map(); // agentName → category channel
  for (const name of agentNames) {
    const existing = allChannels.find(
      (ch) => ch && ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === name.toLowerCase(),
    );
    categories.set(name, existing || (await guild.channels.create({ name, type: ChannelType.GuildCategory })));
  }

  const plan = buildMigrationPlan(config.agents, textChannels);

  // Renames: pane-ascending so `claw-3` → `claw-2` doesn't collide before `claw-2` → `claw-1`.
  const renamesSorted = [...plan.renames].sort((a, b) => {
    if (a.agentName !== b.agentName) return a.agentName.localeCompare(b.agentName);
    return a.pane - b.pane;
  });
  const renamed = [];
  for (const r of renamesSorted) {
    const ch = await guild.channels.fetch(r.id);
    const targetParent = categories.get(r.agentName).id;
    await ch.edit({ name: r.to, parent: targetParent });
    renamed.push({ from: r.from, to: r.to });
  }

  // Move channels already on correct name but wrong category.
  for (const k of plan.keep) {
    const targetParent = categories.get(k.agentName).id;
    if (k.parentId !== targetParent) {
      const ch = await guild.channels.fetch(k.id);
      await ch.edit({ parent: targetParent });
    }
  }

  // Create missing channels.
  const created = [];
  for (const c of plan.creates) {
    const newCh = await guild.channels.create({
      name: c.channelName,
      type: ChannelType.GuildText,
      parent: categories.get(c.agentName).id,
    });
    created.push({ ...c, id: newCh.id });
  }

  // Build channelName → channelId mapping for agents.yaml.
  const channelMap = new Map();
  for (const k of plan.keep) channelMap.set(k.channelName, k.id);
  for (const r of renamesSorted) channelMap.set(r.to, r.id);
  for (const c of created) channelMap.set(c.channelName, c.id);

  // Position channels within each category (pane ascending).
  for (const name of agentNames) {
    const ids = [];
    for (let p = 0; p < config.agents.get(name).panes; p++) {
      const id = channelMap.get(`${name}-${p}`);
      if (id) ids.push(id);
    }
    for (let i = 0; i < ids.length; i++) {
      try {
        const ch = await guild.channels.fetch(ids[i]);
        await ch.setPosition(i);
      } catch {}
    }
  }

  // Reuse agent UUIDs across syncs.
  const prevSync = state.get("sync", {});
  const prevAgents = prevSync.agents || {};
  const agentIds = new Map();
  for (const name of agentNames) {
    agentIds.set(name, prevAgents[name]?.id || randomUUID());
  }

  const syncState = {
    channels: Object.fromEntries(channelMap),
    agents: Object.fromEntries(agentNames.map((name) => [name, { id: agentIds.get(name) }])),
  };
  state.set("sync", syncState);

  const yamlContent = generateAgentsYaml(config.agents, channelMap, agentIds);
  mkdirSync(dirname(agentsYamlPath), { recursive: true });
  writeFileSync(agentsYamlPath, yamlContent);

  // Extras (claimed beyond configured panes) report as orphans to the user.
  const orphanList = [
    ...plan.orphans.map((ch) => ch.name),
    ...plan.extras.map((ch) => ch.name),
  ];

  return {
    created: created.map((ch) => `#${ch.channelName}`),
    renamed: renamed.map((r) => `#${r.from} → #${r.to}`),
    existing: plan.keep.map((ch) => `#${ch.channelName}`),
    orphaned: orphanList.map((n) => `#${n}`),
  };
}
