import { configInput, defineLegoSpec, field, finiteValueRef, mount, port } from "@v1d/product-spec";

const routeCommand = {
  id: "link.route-command", kind: "event",
  fields: [field("route", finiteValueRef("link.route"))],
} as const;
const routeState = {
  id: "link.route-state", kind: "state",
  fields: [field("route", finiteValueRef("link.route"))],
} as const;
const captureCommand = {
  id: "link.capture-command", kind: "event",
  fields: [field("operation", finiteValueRef("link.capture-operation"))],
} as const;
const captureState = {
  id: "link.capture-state", kind: "state",
  fields: [
    field("phase", finiteValueRef("link.capture-phase")),
    field("startedAtMs", "integer", { nullable: true, unit: "ms", clockDomain: "wall" }),
    field("byteCount", "integer", { unit: "byte" }),
  ],
} as const;
const capturedTurn = {
  id: "link.captured-turn", kind: "snapshot",
  fields: [
    field("turnId", "string"), field("targetId", "string"), field("payloadRef", "string"),
    field("idempotencyKey", "string"),
    field("createdAtMs", "integer", { unit: "ms", clockDomain: "wall" }),
  ],
} as const;
const conversationState = {
  id: "link.conversation-state", kind: "state",
  fields: [
    field("turnId", "string", { nullable: true }),
    field("deliveryPhase", finiteValueRef("link.delivery-phase"), { nullable: true }),
    field("replyPhase", finiteValueRef("link.reply-phase"), { nullable: true }),
    field("offline", "boolean"), field("idempotencyKey", "string", { nullable: true }),
  ],
} as const;
const playbackCommand = {
  id: "link.playback-command", kind: "event",
  fields: [field("operation", finiteValueRef("link.playback-operation")), field("turnId", "string")],
} as const;
const playbackState = {
  id: "link.playback-state", kind: "state",
  fields: [
    field("turnId", "string", { nullable: true }),
    field("phase", finiteValueRef("link.playback-phase")),
    field("positionMs", "integer", { unit: "ms" }),
    field("durationMs", "integer", { unit: "ms" }),
  ],
} as const;
const textTurn = {
  id: "link.text-turn", kind: "event",
  fields: [field("text", "string")],
} as const;
const targetState = {
  id: "link.target-state", kind: "state",
  fields: [
    field("selectedTargetId", "string", { nullable: true }),
    field("kind", finiteValueRef("link.target-kind"), { nullable: true }),
    field("availableCount", "integer"),
  ],
} as const;
const targetSelect = {
  id: "link.target-select", kind: "event",
  fields: [field("targetId", "string")],
} as const;
const sessionState = {
  id: "link.session-state", kind: "state",
  fields: [
    field("connection", finiteValueRef("link.connection-state")),
    field("connectionDetail", "string", { nullable: true }),
    field("publicLinkActive", "boolean"),
  ],
} as const;
const historyState = {
  id: "link.history-state", kind: "state",
  fields: [field("retainedTurns", "integer"), field("maxTurns", "integer")],
} as const;
const preferencesState = {
  id: "link.preferences-state", kind: "state",
  fields: [field("handsFree", "boolean"), field("speakReplies", "boolean")],
} as const;
const preferenceToggle = {
  id: "link.preference-toggle", kind: "event",
  fields: [field("key", finiteValueRef("link.preference-key")), field("enabled", "boolean")],
} as const;
const updateState = {
  id: "link.update-state", kind: "state",
  fields: [field("phase", finiteValueRef("link.update-phase"))],
} as const;
const updateCommand = {
  id: "link.update-command", kind: "event",
  fields: [field("operation", finiteValueRef("link.update-operation"))],
} as const;
const recoveryState = {
  id: "link.recovery-state", kind: "state",
  fields: [
    field("phase", finiteValueRef("link.recovery-phase")),
    field("detail", "string", { nullable: true }),
  ],
} as const;

const runtime = (
  stateOwner: "none" | "instance" | "external",
  lifetime: "call" | "operation" | "instance" | "process",
  durability: "transient" | "durable",
  clockDomain: "none" | "monotonic" | "wall",
  contextInputs: readonly string[],
  effects: readonly string[],
) => ({ stateOwner, lifetime, durability, clockDomain, contextInputs, effects });

export const navigationService = defineLegoSpec({
  id: "link.navigation", role: "adapter",
  inputs: [port("open", routeCommand)], outputs: [port("destination", routeState)],
  runtime: runtime("instance", "instance", "transient", "none", [], []),
} as const);
export const captureService = defineLegoSpec({
  id: "link.capture", role: "source",
  inputs: [port("command", captureCommand)],
  outputs: [port("status", captureState), port("captured", capturedTurn)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "operation", "durable", "monotonic", ["microphone.permission"], ["audio.capture", "storage.write"]),
} as const);
export const conversationService = defineLegoSpec({
  id: "link.conversation", role: "adapter",
  inputs: [port("turn", capturedTurn), port("compose", textTurn)],
  outputs: [port("status", conversationState)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);
export const playbackService = defineLegoSpec({
  id: "link.playback", role: "consumer",
  inputs: [port("command", playbackCommand)],
  outputs: [port("status", playbackState)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

/** Owns the tailnet/public route table; route policy math stays native. */
export const targetDirectoryService = defineLegoSpec({
  id: "link.target-directory", role: "adapter",
  inputs: [port("select", targetSelect)],
  outputs: [port("directory", targetState)],
  runtime: runtime("instance", "process", "durable", "none", ["transport.route-policy"], ["storage.write"]),
} as const);
/** Public mailbox session and connection truth; polling and auth transports stay native. */
export const sessionService = defineLegoSpec({
  id: "link.session", role: "adapter",
  inputs: [],
  outputs: [port("status", sessionState)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity", "keystore.session"], ["transport.poll", "transport.auth"]),
} as const);
/** Local history retention truth; the retention policy constant stays native. */
export const historyService = defineLegoSpec({
  id: "link.history", role: "adapter",
  inputs: [],
  outputs: [port("status", historyState)],
  runtime: runtime("external", "process", "durable", "none", [], []),
} as const);
/** Durable user preferences behind typed toggles; SharedPreferences stays native. */
export const preferencesService = defineLegoSpec({
  id: "link.preferences", role: "adapter",
  inputs: [port("toggle", preferenceToggle)],
  outputs: [port("status", preferencesState)],
  runtime: runtime("external", "process", "durable", "none", ["storage.preferences"], ["storage.write"]),
} as const);
/** Release check and install flow; manifest verification and APK handling stay native. */
export const updatesService = defineLegoSpec({
  id: "link.updates", role: "adapter",
  inputs: [port("command", updateCommand)],
  outputs: [port("status", updateState)],
  runtime: runtime("instance", "process", "transient", "wall", ["network.connectivity"], ["network.fetch", "apk.install"]),
} as const);
/** State-repository recovery truth; quarantine mechanics stay native. */
export const recoveryService = defineLegoSpec({
  id: "link.recovery", role: "source",
  inputs: [],
  outputs: [port("status", recoveryState)],
  runtime: runtime("external", "process", "durable", "wall", ["storage.state-repository"], []),
} as const);

export const linkServiceMounts = [
  mount("navigation", navigationService),
  mount("capture", captureService, { policy: "link.capture-policy" }),
  mount("conversation", conversationService, { policy: "link.conversation-policy" }),
  mount("playback", playbackService, { policy: "link.playback-policy" }),
  mount("target", targetDirectoryService),
  mount("session", sessionService),
  mount("history", historyService),
  mount("preferences", preferencesService),
  mount("updates", updatesService),
  mount("recovery", recoveryService),
] as const;

export const linkServiceConfigs = [
  { id: "link.capture-policy" }, { id: "link.conversation-policy" },
  { id: "link.playback-policy" },
] as const;
