import {
  defineStateAuthority,
  defineStatePresentation,
  mapFiniteCases,
  statePresentationField,
} from "@v1d/product-spec";
import {
  captureStatusContract,
  conversationStatusContract,
  playbackStatusContract,
  recoveryStatusContract,
  sessionStatusContract,
  targetDirectoryContract,
  updateStatusContract,
} from "./contracts.js";
import {
  linkCapturePhases,
  linkConnectionStates,
  linkDeliveryPhases,
  linkPlaybackPhases,
  linkRecoveryPhases,
  linkReplyPhases,
  linkTargetKinds,
  linkUpdatePhases,
} from "./finite-values.js";

const capturePhasePresentation = defineStatePresentation(linkCapturePhases, {
  id: "link.capture-phase",
  fields: [statePresentationField("phase", linkCapturePhases)],
  cases: mapFiniteCases(linkCapturePhases, (phase) => ({ phase })),
});
export const capturePhaseAuthority = defineStateAuthority({
  id: capturePhasePresentation.id,
  source: {
    portRef: "capture.service.status",
    contract: captureStatusContract,
    stateField: "phase",
    states: linkCapturePhases,
  },
  presentation: capturePhasePresentation,
});

const deliveryPhasePresentation = defineStatePresentation(linkDeliveryPhases, {
  id: "link.delivery-phase",
  fields: [statePresentationField("phase", linkDeliveryPhases)],
  cases: mapFiniteCases(linkDeliveryPhases, (phase) => ({ phase })),
});
export const deliveryPhaseAuthority = defineStateAuthority({
  id: deliveryPhasePresentation.id,
  source: {
    portRef: "conversation.service.status",
    contract: conversationStatusContract,
    stateField: "deliveryPhase",
    states: linkDeliveryPhases,
  },
  presentation: deliveryPhasePresentation,
});

const replyPhasePresentation = defineStatePresentation(linkReplyPhases, {
  id: "link.reply-phase",
  fields: [statePresentationField("phase", linkReplyPhases)],
  cases: mapFiniteCases(linkReplyPhases, (phase) => ({ phase })),
});
export const replyPhaseAuthority = defineStateAuthority({
  id: replyPhasePresentation.id,
  source: {
    portRef: "conversation.service.status",
    contract: conversationStatusContract,
    stateField: "replyPhase",
    states: linkReplyPhases,
  },
  presentation: replyPhasePresentation,
});

const playbackPhasePresentation = defineStatePresentation(linkPlaybackPhases, {
  id: "link.playback-phase",
  fields: [statePresentationField("phase", linkPlaybackPhases)],
  cases: mapFiniteCases(linkPlaybackPhases, (phase) => ({ phase })),
});
export const playbackPhaseAuthority = defineStateAuthority({
  id: playbackPhasePresentation.id,
  source: {
    portRef: "playback.service.status",
    contract: playbackStatusContract,
    stateField: "phase",
    states: linkPlaybackPhases,
  },
  presentation: playbackPhasePresentation,
});

const targetKindPresentation = defineStatePresentation(linkTargetKinds, {
  id: "link.target-kind",
  fields: [statePresentationField("kind", linkTargetKinds)],
  cases: mapFiniteCases(linkTargetKinds, (kind) => ({ kind })),
});
export const targetKindAuthority = defineStateAuthority({
  id: targetKindPresentation.id,
  source: {
    portRef: "target.service.directory",
    contract: targetDirectoryContract,
    stateField: "kind",
    states: linkTargetKinds,
  },
  presentation: targetKindPresentation,
});

const connectionStatePresentation = defineStatePresentation(linkConnectionStates, {
  id: "link.connection-state",
  fields: [statePresentationField("connection", linkConnectionStates)],
  cases: mapFiniteCases(linkConnectionStates, (connection) => ({ connection })),
});
export const connectionStateAuthority = defineStateAuthority({
  id: connectionStatePresentation.id,
  source: {
    portRef: "session.service.status",
    contract: sessionStatusContract,
    stateField: "connection",
    states: linkConnectionStates,
  },
  presentation: connectionStatePresentation,
});

const updatePhasePresentation = defineStatePresentation(linkUpdatePhases, {
  id: "link.update-phase",
  fields: [statePresentationField("phase", linkUpdatePhases)],
  cases: mapFiniteCases(linkUpdatePhases, (phase) => ({ phase })),
});
export const updatePhaseAuthority = defineStateAuthority({
  id: updatePhasePresentation.id,
  source: {
    portRef: "updates.service.status",
    contract: updateStatusContract,
    stateField: "phase",
    states: linkUpdatePhases,
  },
  presentation: updatePhasePresentation,
});

const recoveryPhasePresentation = defineStatePresentation(linkRecoveryPhases, {
  id: "link.recovery-phase",
  fields: [statePresentationField("phase", linkRecoveryPhases)],
  cases: mapFiniteCases(linkRecoveryPhases, (phase) => ({ phase })),
});
export const recoveryPhaseAuthority = defineStateAuthority({
  id: recoveryPhasePresentation.id,
  source: {
    portRef: "recovery.service.status",
    contract: recoveryStatusContract,
    stateField: "phase",
    states: linkRecoveryPhases,
  },
  presentation: recoveryPhasePresentation,
});

export const linkStateAuthorityDefinitions = [
  capturePhaseAuthority,
  deliveryPhaseAuthority,
  replyPhaseAuthority,
  playbackPhaseAuthority,
  targetKindAuthority,
  connectionStateAuthority,
  updatePhaseAuthority,
  recoveryPhaseAuthority,
] as const;
