#!/usr/bin/env node
// One-shot sync CLI. Runs executeSync outside the bot (useful for migrations
// before/without the bot running). Bot must be stopped first — two gateway
// connections with the same token will fight.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits } from "discord.js";
import { resolveConfigSources } from "../core/config-sources.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { createState } from "../core/state.mjs";
import { executeSync } from "../core/sync-discord.mjs";
import { parseConfig } from "../sync.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");

loadRuntimeEnv({ packageRoot: ROOT });
const configSources = resolveConfigSources({ packageDir: ROOT });

const TOKEN = process.env.DISCORD_TOKEN;
const AGENTS_YAML = runtimeAgentsPath();
const AGENTMUX_YAML = configSources.agentmuxYaml.path;
const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";

if (!TOKEN) { console.error("DISCORD_TOKEN missing"); process.exit(1); }

const configYaml = readFileSync(AGENTMUX_YAML, "utf-8");
const { guild: guildId } = parseConfig(configYaml, { requireGuild: true });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(guildId);
    const state = createState(STATE_FILE);
    const results = await executeSync({ guild, configYaml, state, agentsYamlPath: AGENTS_YAML });

    if (results.created.length) console.log(`created:  ${results.created.join(", ")}`);
    if (results.renamed.length) console.log(`renamed:  ${results.renamed.join(", ")}`);
    if (results.existing.length) console.log(`existing: ${results.existing.join(", ")}`);
    if (results.orphaned.length) console.log(`orphaned: ${results.orphaned.join(", ")}`);
    const total = results.created.length + results.renamed.length + results.existing.length;
    console.log(`${total} channel(s) synced`);
  } catch (err) {
    console.error("sync failed:", err);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(TOKEN);
