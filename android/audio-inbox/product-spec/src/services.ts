import { defineLegoSpec, field, finiteValueRef, mount, port } from "@v1d/product-spec";

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
  runtime: runtime("external", "operation", "durable", "monotonic", ["microphone.permission"], ["audio.capture", "storage.write"]),
} as const);
export const conversationService = defineLegoSpec({
  id: "link.conversation", role: "adapter",
  inputs: [port("turn", capturedTurn)],
  outputs: [port("status", conversationState)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);
export const playbackService = defineLegoSpec({
  id: "link.playback", role: "consumer",
  inputs: [port("command", playbackCommand)],
  outputs: [port("status", playbackState)],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

export const linkServiceMounts = [
  mount("navigation", navigationService),
  mount("capture", captureService, { policy: "link.capture-policy" }),
  mount("conversation", conversationService, { policy: "link.conversation-policy" }),
  mount("playback", playbackService, { policy: "link.playback-policy" }),
] as const;

export const linkServiceConfigs = [
  { id: "link.capture-policy" }, { id: "link.conversation-policy" },
  { id: "link.playback-policy" },
] as const;
