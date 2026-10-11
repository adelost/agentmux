// Node --import bootstrap: restore release/user runtime configuration before any service starts.
import { homedir } from "node:os";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";

loadRuntimeEnv();

// Every program the bridge starts inherits its working directory. start.sh
// starts it in the package directory, which each `npm install --global`
// replaces; claude, codex and git then refuse to run until a restart
// (2026-10-11). Node has already resolved the entry point and every --import.
process.chdir(homedir());
