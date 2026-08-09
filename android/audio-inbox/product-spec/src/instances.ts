import {
  captureService,
  conversationService,
  historyService,
  navigationService,
  playbackService,
  preferencesService,
  recoveryService,
  sessionService,
  targetDirectoryService,
  updatesService,
} from "./services.js";

/**
 * The ten service instances. Every Link service is process-lived: the
 * coordinator already owns them for the whole app lifetime, so none carries a
 * demand port and none is leased. Capture is operation-scoped state inside the
 * process-lived service, exactly like the recorder it wraps.
 */
export const linkServices = [
  {
    id: "navigation.service", serviceTypeRef: navigationService.id,
    config: {},
    bindings: {
      openSettings: "settings-action.open",
      openDevHost: "dev-host.open",
    },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "capture.service", serviceTypeRef: captureService.id,
    config: { policy: "link.capture-policy" },
    bindings: { command: "talk.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "conversation.service", serviceTypeRef: conversationService.id,
    config: { policy: "link.conversation-policy" },
    bindings: {
      turn: "capture.service.captured",
      compose: "composer.compose",
    },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "playback.service", serviceTypeRef: playbackService.id,
    config: { policy: "link.playback-policy" },
    bindings: { command: "active-playback.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "target.service", serviceTypeRef: targetDirectoryService.id,
    config: {},
    bindings: { select: "target.select" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "session.service", serviceTypeRef: sessionService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "history.service", serviceTypeRef: historyService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "preferences.service", serviceTypeRef: preferencesService.id,
    config: {},
    bindings: { toggle: "preferences.toggle" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "updates.service", serviceTypeRef: updatesService.id,
    config: {},
    bindings: { command: "updates.command" },
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
  {
    id: "recovery.service", serviceTypeRef: recoveryService.id,
    config: {},
    bindings: {},
    activation: { kind: "lifetime", lifecycleSources: [] },
  },
] as const;

export const linkConfigs = [
  { id: "link.capture-policy" },
  { id: "link.conversation-policy" },
  { id: "link.playback-policy" },
] as const;
