// Node --import bootstrap: restore release/user runtime configuration before any service starts.
import { loadRuntimeEnv } from "../core/runtime-env.mjs";

loadRuntimeEnv();
