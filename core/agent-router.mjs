// Target-aware facade used while tmux and the native runtime coexist. Only
// methods whose first arguments identify a pane are routed; fleet lifecycle
// remains explicitly tmux-owned during the canary.

const TARGET_METHODS = new Set([
  "capturePane",
  "captureScreen",
  "getContext",
  "getContextPercent",
  "getResponse",
  "getResponseSegments",
  "getResponseStreamWithRaw",
  "isBusy",
  "paneHistorySize",
  "sendEscape",
  "restartPaneExact",
]);

export function createAgentRouter({ tmuxAgent, nativeRuntime }) {
  if (!tmuxAgent) throw new Error("agent router requires tmuxAgent");
  if (!nativeRuntime) throw new Error("agent router requires nativeRuntime");

  return new Proxy(tmuxAgent, {
    get(target, property, receiver) {
      if (property === "isNativeTarget") return nativeRuntime.isNativeTarget;
      if (property === "deliverQueued") return nativeRuntime.deliverQueued;
      // Native submission and its durable completion receipt are one
      // transport contract. The broker calls deliveryStatus with the queued
      // job (not a name/pane pair), so it cannot use TARGET_METHODS routing.
      if (property === "deliveryStatus") return nativeRuntime.deliveryStatus;
      if (property === "nativeRuntime") return nativeRuntime;
      if (property === "reconcileSession") {
        return async (name, ...args) => {
          if (!nativeRuntime.isNativeTarget(name, 0)) {
            return Reflect.get(target, property, receiver)(name, ...args);
          }
          const agents = await nativeRuntime.ensureSession(name);
          return { name, skipped: true, native: true, provisioned: agents.length };
        };
      }
      if (property === "ensureReady") {
        return (name, pane = 0, ...args) => nativeRuntime.isNativeTarget(name, pane)
          ? nativeRuntime.ensureTarget(name, pane)
          : Reflect.get(target, property, receiver)(name, pane, ...args);
      }
      if (property === "restartCodex") {
        return (name, pane = 0, options = {}) => nativeRuntime.isNativeTarget(name, pane)
          ? nativeRuntime.updateSettings(name, pane, options)
          : Reflect.get(target, property, receiver)(name, pane, options);
      }
      if (property === "restartPaneExact") {
        return (name, pane = 0, options = {}) => nativeRuntime.isNativeTarget(name, pane)
          ? Promise.resolve({ ok: false, reason: "native-runtime-owns-session" })
          : Reflect.get(target, property, receiver)(name, pane, options);
      }
      if (property === "startProgressTimer") {
        return (send, name, pane = 0, options = {}) => nativeRuntime.isNativeTarget(name, pane)
          ? nativeRuntime.startProgressTimer(send, name, pane, options)
          : Reflect.get(target, property, receiver)(send, name, pane, options);
      }
      if (TARGET_METHODS.has(property)) {
        return (...args) => {
          const [name, pane = 0] = args;
          if (nativeRuntime.isNativeTarget(name, pane)) {
            const method = property === "getContextPercent"
              ? "getContext"
              : property === "captureScreen" ? "capturePane" : property;
            return nativeRuntime[method](...args);
          }
          return Reflect.get(target, property, receiver)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
