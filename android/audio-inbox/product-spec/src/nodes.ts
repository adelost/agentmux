import {
  captureService,
  capturePresentation,
  conversationService,
  conversationPresentation,
  historyService,
  historyPresentation,
  navigationService,
  playbackService,
  playbackPresentation,
  preferencesService,
  preferencesPresentation,
  recoveryService,
  recoveryPresentation,
  sessionService,
  sessionPresentation,
  targetDirectoryService,
  targetPresentation,
  updatesService,
  updatesPresentation,
} from "./node-types.js";
import {
  capturePhaseAuthority,
  connectionStateAuthority,
  deliveryPhaseAuthority,
  playbackPhaseAuthority,
  recoveryPhaseAuthority,
  replyPhaseAuthority,
  targetKindAuthority,
  updatePhaseAuthority,
} from "./state-authorities.js";

/**
 * Ten effect-owning services followed by ten final presentations. Every Link service is process-lived: the
 * coordinator already owns them for the whole app lifetime, so none carries a
 * demand port and none is leased. Capture is operation-scoped state inside the
 * process-lived service, exactly like the recorder it wraps.
 */
export const linkNodes = [
  {
    id: "navigation.service", nodeTypeRef: navigationService.id,
    config: {},
    bindings: {
      openSettings: "settings-action.open",
      openDevHost: "dev-host.open",
    },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "capture.service", nodeTypeRef: captureService.id,
    config: { policy: "link.capture-policy" },
    bindings: { command: "talk.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "conversation.service", nodeTypeRef: conversationService.id,
    config: { policy: "link.conversation-policy" },
    bindings: {
      turn: "capture.service.captured",
      compose: "composer.compose",
    },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "playback.service", nodeTypeRef: playbackService.id,
    config: { policy: "link.playback-policy" },
    bindings: { command: "active-playback.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "target.service", nodeTypeRef: targetDirectoryService.id,
    config: {},
    bindings: { select: "target.select" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "session.service", nodeTypeRef: sessionService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "history.service", nodeTypeRef: historyService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "preferences.service", nodeTypeRef: preferencesService.id,
    config: {},
    bindings: { toggle: "preferences.toggle" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "updates.service", nodeTypeRef: updatesService.id,
    config: {},
    bindings: { command: "updates.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "recovery.service", nodeTypeRef: recoveryService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "capture.presentation", nodeTypeRef: capturePresentation.id,
    config: {}, bindings: { source: "capture.service.status" },
  },
  {
    id: "conversation.presentation", nodeTypeRef: conversationPresentation.id,
    config: {}, bindings: { source: "conversation.service.status" },
  },
  {
    id: "playback.presentation", nodeTypeRef: playbackPresentation.id,
    config: {}, bindings: { source: "playback.service.status" },
  },
  {
    id: "target.presentation", nodeTypeRef: targetPresentation.id,
    config: {}, bindings: { source: "target.service.directory" },
  },
  {
    id: "session.presentation", nodeTypeRef: sessionPresentation.id,
    config: {}, bindings: { source: "session.service.status" },
  },
  {
    id: "history.presentation", nodeTypeRef: historyPresentation.id,
    config: {}, bindings: { source: "history.service.status" },
  },
  {
    id: "preferences.presentation", nodeTypeRef: preferencesPresentation.id,
    config: {}, bindings: { source: "preferences.service.status" },
  },
  {
    id: "updates.presentation", nodeTypeRef: updatesPresentation.id,
    config: {}, bindings: { source: "updates.service.status" },
  },
  {
    id: "recovery.presentation", nodeTypeRef: recoveryPresentation.id,
    config: {}, bindings: { source: "recovery.service.status" },
  },
  capturePhaseAuthority.adapter.node,
  deliveryPhaseAuthority.adapter.node,
  replyPhaseAuthority.adapter.node,
  playbackPhaseAuthority.adapter.node,
  targetKindAuthority.adapter.node,
  connectionStateAuthority.adapter.node,
  updatePhaseAuthority.adapter.node,
  recoveryPhaseAuthority.adapter.node,
] as const;

export const linkConfigs = [
  { id: "link.capture-policy" },
  { id: "link.conversation-policy" },
  { id: "link.playback-policy" },
] as const;
