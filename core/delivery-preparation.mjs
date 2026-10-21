import { AsyncLocalStorage } from "node:async_hooks";

const preparations = new AsyncLocalStorage();
const DEFAULT_TIMEOUT_MS = 60_000;

function expired(scope) {
  return Object.assign(new Error(`preparation-timeout:${scope.stage}:${scope.timeoutMs}ms`), {
    code: "AMUX_DELIVERY_PREPARATION_EXPIRED", stage: scope.stage,
  });
}

/** WHAT: Checks that a continuation still owns its preparation. WHY: Prevents a timed-out read from typing or overwriting a newer owner's state. */
export function assertDeliveryPreparation() {
  const scope = preparations.getStore();
  if (scope && (scope.closed || (!scope.inputStarted && performance.now() >= scope.deadline))) throw expired(scope);
}

/** WHAT: Stores the actual input-dispatch boundary. WHY: Keeps already-started input under its original receipt and physical fences. */
export function beginDeliveryInput() {
  assertDeliveryPreparation();
  const scope = preparations.getStore();
  if (scope) { scope.inputStarted = true; clearTimeout(scope.timer); }
}

/** WHAT: Stores exact unsent-intent cleanup with the writer. WHY: Prevents a pre-input timeout from leaving a compact intent that implies a model call began. */
export function onUnsentPreparationTimeout(cleanup) {
  assertDeliveryPreparation();
  preparations.getStore()?.cleanups.push(cleanup);
}

/** WHAT: Names the current preparation await without payload data. WHY: Keeps a refusal attributable to its stalled owner without message text. */
export function deliveryPreparationStage(stage, work) {
  assertDeliveryPreparation();
  const scope = preparations.getStore();
  const previous = scope?.stage, previousToken = scope?.stageToken, token = {};
  if (scope) { scope.stage = stage; scope.stageToken = token; }
  const finish = () => {
    if (scope && !scope.closed && scope.stageToken === token) { scope.stage = previous; scope.stageToken = previousToken; }
  };
  try {
    const result = work();
    if (result && typeof result.then === "function") return result.finally(finish);
    finish(); return result;
  } catch (error) { finish(); throw error; }
}

/** WHAT: Builds scoped observation of existing agent calls. WHY: Keeps captured maintenance owners on the same guard without a second transport. */
export function preparationAgent(agent) {
  return new Proxy(agent, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => deliveryPreparationStage(String(key), () => {
      // Native dispatch has its own HTTP idempotency and ambiguity owner.
      if (key === "deliverQueued") beginDeliveryInput();
      return value.apply(target, args);
    });
  } });
}

/** WHAT: Returns one leased head's bounded preparation result. WHY: Prevents a stalled reader from retaining its lease or writing after its writer ends. */
export async function withDeliveryPreparation({ timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout }, work) {
  const scope = { timeoutMs, deadline: performance.now() + timeoutMs, stage: "preflight", closed: false, inputStarted: false, cleanups: [] };
  const timeout = new Promise((_, reject) => {
    scope.timer = setTimeout(() => { scope.closed = true; reject(expired(scope)); }, timeoutMs);
  });
  try { return await Promise.race([preparations.run(scope, work), timeout]); }
  catch (error) {
    if (error.code !== "AMUX_DELIVERY_PREPARATION_EXPIRED") throw error;
    scope.closed = true;
    for (const cleanup of scope.cleanups) cleanup(error);
    return onTimeout(error);
  } finally { scope.closed = true; clearTimeout(scope.timer); }
}
