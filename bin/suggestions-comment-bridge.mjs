#!/usr/bin/env node

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  createAmuxCommentDeliverer,
  createAmuxCommentNotifier,
  expandHome,
  loadSuggestionsBridgeConfig,
  loadSuggestionsBridgeState,
  pollSuggestionsComments,
  saveSuggestionsBridgeState,
} from "../core/suggestions-comment-bridge.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = "~/.config/agent/suggestions-comment-bridge.yaml";

function parseArgs(argv) {
  const result = { status: false, help: false, config: null, state: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--status") result.status = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--config" || arg === "--state") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      result[arg.slice(2)] = value;
    } else throw new Error(`unknown argument '${arg}'`);
  }
  return result;
}

function usage() {
  console.log(`Usage: suggestions-comment-bridge.mjs [--config PATH] [--state PATH] [--status]

Poll once by default. Cron scheduling and overlap locking live in
bin/suggestions-comment-bridge-cron.sh.`);
}

function statusLine(config, state) {
  const rows = Object.entries(config.projects).map(([projectId, target]) => {
    const project = state.projects[projectId];
    const comments = Object.values(project?.comments || {});
    const answered = comments.filter((comment) => comment.answeredAt != null).length;
    const unanswered = comments.length - answered;
    return `${projectId}->${target.agent}:${target.pane} bootstrap=${Boolean(project?.bootstrapped)} `
      + `answered=${answered} unanswered=${unanswered}`;
  });
  return rows.join("\n");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const configPath = expandHome(args.config || process.env.AMUX_SUGGESTIONS_CONFIG || DEFAULT_CONFIG);
  const config = loadSuggestionsBridgeConfig(configPath);
  const statePath = expandHome(args.state || process.env.AMUX_SUGGESTIONS_STATE || config.statePath);
  const state = loadSuggestionsBridgeState(statePath);
  if (args.status) {
    console.log(statusLine(config, state));
    process.exit(0);
  }
  const configuredAmux = process.env.AMUX_SUGGESTIONS_AMUX_BIN || resolve(SCRIPT_DIR, "agent-cli.mjs");
  const amuxBin = configuredAmux.includes("/") ? resolve(configuredAmux) : configuredAmux;
  const result = await pollSuggestionsComments({
    config,
    state,
    deliver: createAmuxCommentDeliverer({ amuxBin }),
    notify: createAmuxCommentNotifier({ amuxBin }),
    persist: (next) => saveSuggestionsBridgeState(statePath, next),
  });
  if (result.delivered > 0) console.log(`OK delivered=${result.delivered}`);
} catch (error) {
  console.error(`ERROR suggestions-comment-bridge: ${error.message}`);
  process.exit(1);
}
