import { randomUUID } from "node:crypto";
import { setTimeout as waitFor } from "node:timers/promises";
import { composerDraft } from "../core/dialects.mjs";
import { clearComposerRecipe } from "../core/composer-control.mjs";
import { detectPaneStatus } from "./format.mjs";

/** WHAT: Checks that an idle editor clears its draft. WHY: Prevents key dispatch from masquerading as a cleared draft. */
export async function clearComposerAndVerify({ capture, send, target, record, actor = null,
  controlId = randomUUID(), now = () => new Date(), wait = waitFor }) {
  const before = await capture(), draft = composerDraft(before);
  if (draft === null) throw new Error("clearline refused: no composer is visible");
  if (detectPaneStatus(before) !== "idle") throw new Error("clearline refused: pane is not idle");
  const observed = (receipt, state, detail) => record({
    ts: now().toISOString(), event: `composer_control_${state}`, ...target,
    controlId: receipt.controlId, action: "clearline", keys: receipt.keys, actor, detail,
  });
  if (draft === "") {
    const receipt = Object.freeze({ controlId, action: "clearline", keys: Object.freeze([]),
      target: `${target.session}:${target.pane}`, verified: true, alreadyEmpty: true });
    observed(receipt, "verified", "composer already empty; no keys sent");
    return receipt;
  }
  const receipt = await send(clearComposerRecipe(before));
  let failure = "composer remained nonempty";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt) await wait(100);
    let snapshot;
    try { snapshot = await capture(); }
    catch (error) { failure = `composer observation failed: ${error.message}`; break; }
    if (composerDraft(snapshot) === "") {
      observed(receipt, "verified", "empty composer observed after clear");
      return Object.freeze({ ...receipt, verified: true });
    }
  }
  observed(receipt, "unverified", failure);
  throw new Error(`clearline was sent but an empty composer was not verified (${failure}); do not retry blindly`);
}
