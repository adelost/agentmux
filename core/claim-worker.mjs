import { parentPort, workerData } from "node:worker_threads";
import { createClaimSources } from "./claim-sources.mjs";
import { checkReply } from "./claim-guard.mjs";

// Git and file reads run outside the bridge's input event loop.
let sources, at = 0;
parentPort.on("message", ({ id, text }) => {
  try {
    if (!sources || Date.now() - at > 60000) { sources = createClaimSources(workerData.repos); at = Date.now(); }
    parentPort.postMessage({ id, result: checkReply(text, sources) });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
