import { defineLegoSpec, field, mount, port } from "@v1d/product-spec";

const routeCommand = {
  id: "link.route-command", kind: "event",
  fields: [field("route", "string")],
} as const;
const routeState = {
  id: "link.route-state", kind: "state",
  fields: [field("route", "string")],
} as const;
const captureCommand = {
  id: "link.capture-command", kind: "event",
  fields: [field("operation", "string")],
} as const;
const captureState = {
  id: "link.capture-state", kind: "state",
  fields: [
    field("phase", "string"),
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
const deliveryState = {
  id: "link.delivery-state", kind: "state",
  fields: [
    field("turnId", "string", { nullable: true }), field("phase", "string"),
    field("offline", "boolean"), field("idempotencyKey", "string", { nullable: true }),
  ],
} as const;
const acceptedTurn = {
  id: "link.accepted-turn", kind: "snapshot",
  fields: [
    field("turnId", "string"), field("targetId", "string"), field("idempotencyKey", "string"),
    field("durablyAccepted", "boolean"),
  ],
} as const;
const replyState = {
  id: "link.reply-state", kind: "state",
  fields: [
    field("turnId", "string", { nullable: true }), field("phase", "string"),
    field("offline", "boolean"),
  ],
} as const;
const readyReply = {
  id: "link.ready-reply", kind: "snapshot",
  fields: [
    field("turnId", "string"), field("body", "string"),
    field("audioRef", "string", { nullable: true }),
    field("receivedAtMs", "integer", { unit: "ms", clockDomain: "wall" }),
  ],
} as const;
const playbackCommand = {
  id: "link.playback-command", kind: "event",
  fields: [field("operation", "string"), field("turnId", "string")],
} as const;
const playbackState = {
  id: "link.playback-state", kind: "state",
  fields: [
    field("turnId", "string", { nullable: true }), field("phase", "string"),
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
export const deliveryService = defineLegoSpec({
  id: "link.delivery", role: "adapter",
  inputs: [port("turn", capturedTurn)],
  outputs: [port("status", deliveryState), port("accepted", acceptedTurn)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "retry.schedule"]),
} as const);
export const replyService = defineLegoSpec({
  id: "link.reply", role: "adapter",
  inputs: [port("accepted", acceptedTurn)],
  outputs: [port("status", replyState), port("reply", readyReply)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["transport.receive", "storage.write"]),
} as const);
export const playbackService = defineLegoSpec({
  id: "link.playback", role: "consumer",
  inputs: [port("reply", readyReply), port("command", playbackCommand)],
  outputs: [port("status", playbackState)],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

export const linkServiceMounts = [
  mount("navigation", navigationService),
  mount("capture", captureService, { policy: "link.capture-policy" }),
  mount("delivery", deliveryService, { policy: "link.delivery-policy" }),
  mount("reply", replyService, { policy: "link.reply-policy" }),
  mount("playback", playbackService, { policy: "link.playback-policy" }),
] as const;

export const linkServiceConfigs = [
  { id: "link.capture-policy" }, { id: "link.delivery-policy" },
  { id: "link.reply-policy" }, { id: "link.playback-policy" },
] as const;
