#!/usr/bin/env node

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  createAmuxBoardAuthNotifier,
  createAmuxCommentDeliverer,
  createAmuxCommentNotifier,
  expandHome,
  loadSuggestionsBridgeConfig,
  loadSuggestionsBridgeState,
  loadSuggestionsReadCredential,
  isSuggestionsAuthenticationError,
  pollSuggestionsComments,
  saveSuggestionsBridgeState,
} from "../core/suggestions-comment-bridge.mjs";
import { writeGuardHeartbeat } from "../core/guard-heartbeat.mjs";

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
    const terminal = comments.filter((comment) => comment.terminalAt != null).length;
    const unanswered = comments.length - answered - terminal;
    return `${projectId}->${target.agent}:${target.pane} bootstrap=${Boolean(project?.bootstrapped)} `
      + `answered=${answered} unanswered=${unanswered} terminal=${terminal}`;
  });
  const lastSync = Number.isFinite(state.lastSuccessfulSyncAt)
    ? new Date(state.lastSuccessfulSyncAt).toISOString() : "never";
  return `last_successful_sync=${lastSync}\n${rows.join("\n")}`;
}

let amuxBin = null;
let state = null;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const configPath = expandHome(args.config || process.env.AMUX_SUGGESTIONS_CONFIG || DEFAULT_CONFIG);
  const allowTestOrigin = process.env.NODE_ENV === "test"
    && process.env.AMUX_SUGGESTIONS_TEST_ORIGIN === "1";
  const config = loadSuggestionsBridgeConfig(configPath, { allowTestOrigin });
  const statePath = expandHome(args.state || process.env.AMUX_SUGGESTIONS_STATE || config.statePath);
  state = loadSuggestionsBridgeState(statePath);
  if (args.status) {
    console.log(statusLine(config, state));
    process.exit(0);
  }
  const configuredAmux = process.env.AMUX_SUGGESTIONS_AMUX_BIN || resolve(SCRIPT_DIR, "agent-cli.mjs");
  amuxBin = configuredAmux.includes("/") ? resolve(configuredAmux) : configuredAmux;
  const readToken = loadSuggestionsReadCredential(config.credentialFile);
  const result = await pollSuggestionsComments({
    config,
    state,
    readToken,
    allowTestOrigin,
    deliver: createAmuxCommentDeliverer({ amuxBin }),
    notify: createAmuxCommentNotifier({ amuxBin }),
    persist: (next) => saveSuggestionsBridgeState(statePath, next),
  });
  writeGuardHeartbeat({
    key: "comment-bridge",
    intervalSec: 60,
    metrics: {
      projects: Object.keys(config.projects).length,
      delivered: result.delivered,
    },
  });
  if (result.delivered > 0) console.log(`OK delivered=${result.delivered}`);
} catch (error) {
  if (amuxBin && isSuggestionsAuthenticationError(error)) {
    try {
      await createAmuxBoardAuthNotifier({ amuxBin })({
        status: error.status,
        lastSuccessfulSyncAt: state?.lastSuccessfulSyncAt ?? null,
      });
    } catch (notificationError) {
      console.error(`ERROR suggestions-comment-bridge auth page failed: ${notificationError.message}`);
    }
  }
  console.error(`ERROR suggestions-comment-bridge: ${error.message}`);
  process.exit(1);
}
