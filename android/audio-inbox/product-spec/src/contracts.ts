import { field, finiteValueRef, valueRef } from "@v1d/product-spec";

/**
 * Every contract the Link product graph speaks. Data only: no platform
 * symbols, no runtime JSON. `presentation` boundaries feed component inputs,
 * `ui-event` boundaries carry component events into services, and
 * `service-internal` is the one edge UI can never bind.
 */

export const routeOpenContract = {
  id: "link.route-open", kind: "event", boundary: "ui-event",
  fields: [field("route", finiteValueRef("link.route"))],
} as const;
export const routeDestinationContract = {
  id: "link.route-destination", kind: "state", boundary: "presentation",
  fields: [field("route", finiteValueRef("link.route"))],
} as const;

export const captureCommandContract = {
  id: "link.capture-command", kind: "event", boundary: "ui-event",
  fields: [field("operation", finiteValueRef("link.capture-operation"))],
} as const;
export const captureStatusContract = {
  id: "link.capture-status", kind: "state", boundary: "presentation",
  fields: [
    field("phase", finiteValueRef("link.capture-phase")),
    field("available", "boolean"),
    field("unavailableReason", "string", { nullable: true }),
    field("startedAtMs", "integer", { nullable: true, unit: "si.millisecond", clockDomain: "wall" }),
    field("byteCount", "integer", { unit: "si.byte" }),
  ],
} as const;
export const capturedTurnContract = {
  id: "link.captured-turn", kind: "snapshot", boundary: "service-internal",
  fields: [
    field("turnId", "string"), field("targetId", "string"), field("payloadRef", "string"),
    field("idempotencyKey", "string"),
    field("createdAtMs", "integer", { unit: "si.millisecond", clockDomain: "wall" }),
  ],
} as const;

export const conversationStatusContract = {
  id: "link.conversation-status", kind: "state", boundary: "presentation",
  fields: [
    field("turnId", "string", { nullable: true }),
    field("deliveryPhase", finiteValueRef("link.delivery-phase"), { nullable: true }),
    field("replyPhase", finiteValueRef("link.reply-phase"), { nullable: true }),
    field("offline", "boolean"), field("idempotencyKey", "string", { nullable: true }),
    // The bounded local feed the latest-turn component renders.
    field("turns", valueRef("link.turn-list")),
  ],
} as const;
export const composeTurnContract = {
  id: "link.compose-turn", kind: "event", boundary: "ui-event",
  fields: [field("text", "string")],
} as const;

export const playbackCommandContract = {
  id: "link.playback-command", kind: "event", boundary: "ui-event",
  fields: [field("operation", finiteValueRef("link.playback-operation")), field("turnId", "string")],
} as const;
export const playbackStatusContract = {
  id: "link.playback-status", kind: "state", boundary: "presentation",
  fields: [
    field("turnId", "string", { nullable: true }),
    field("phase", finiteValueRef("link.playback-phase")),
    field("positionMs", "integer", { unit: "si.millisecond" }),
    field("durationMs", "integer", { unit: "si.millisecond" }),
    field("turn", valueRef("link.turn"), { nullable: true }),
  ],
} as const;

export const targetDirectoryContract = {
  id: "link.target-directory", kind: "state", boundary: "presentation",
  fields: [
    field("selectedTargetId", "string", { nullable: true }),
    field("kind", finiteValueRef("link.target-kind"), { nullable: true }),
    field("availableCount", "integer"),
    field("targets", valueRef("link.target-list")),
  ],
} as const;
export const targetSelectContract = {
  id: "link.target-select", kind: "event", boundary: "ui-event",
  fields: [field("targetId", "string")],
} as const;

export const sessionStatusContract = {
  id: "link.session-status", kind: "state", boundary: "presentation",
  fields: [
    field("connection", finiteValueRef("link.connection-state")),
    field("connectionDetail", "string", { nullable: true }),
    field("publicLinkActive", "boolean"),
  ],
} as const;

export const historyStatusContract = {
  id: "link.history-status", kind: "state", boundary: "presentation",
  fields: [field("retainedTurns", "integer"), field("maxTurns", "integer")],
} as const;

export const preferencesStatusContract = {
  id: "link.preferences-status", kind: "state", boundary: "presentation",
  fields: [field("handsFree", "boolean"), field("speakReplies", "boolean")],
} as const;
export const preferenceToggleContract = {
  id: "link.preference-toggle", kind: "event", boundary: "ui-event",
  fields: [field("key", finiteValueRef("link.preference-key")), field("enabled", "boolean")],
} as const;

export const updateStatusContract = {
  id: "link.update-status", kind: "state", boundary: "presentation",
  fields: [
    field("phase", finiteValueRef("link.update-phase")),
    // The full ReleaseKit UpdateState the shared update rows render.
    field("update", valueRef("link.update-native")),
  ],
} as const;
export const updateCommandContract = {
  id: "link.update-command", kind: "event", boundary: "ui-event",
  fields: [field("operation", finiteValueRef("link.update-operation"))],
} as const;

export const recoveryStatusContract = {
  id: "link.recovery-status", kind: "state", boundary: "presentation",
  fields: [
    field("phase", finiteValueRef("link.recovery-phase")),
    field("detail", "string", { nullable: true }),
  ],
} as const;
