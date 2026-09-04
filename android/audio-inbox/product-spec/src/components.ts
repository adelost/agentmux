import { componentPort, defineComponentType } from "@v1d/product-spec";
import {
  captureCommandContract,
  captureStatusContract,
  composeTurnContract,
  conversationStatusContract,
  historyStatusContract,
  playbackCommandContract,
  playbackStatusContract,
  preferenceToggleContract,
  preferencesStatusContract,
  recoveryStatusContract,
  activePageContract,
  routeOpenContract,
  sessionStatusContract,
  targetDirectoryContract,
  targetSelectContract,
  updateCommandContract,
  updateStatusContract,
} from "./contracts.js";
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

const componentTree = ["ui.component-tree"] as const;

export const targetPickerComponentType = defineComponentType({
  id: "link.target-picker",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", targetDirectoryContract),
    componentPort("targetState", targetKindAuthority.authority.presentation.contract),
  ],
  outputs: [componentPort("select", targetSelectContract)],
});
export const talkComponentType = defineComponentType({
  id: "link.talk",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", captureStatusContract),
    componentPort("captureState", capturePhaseAuthority.authority.presentation.contract),
  ],
  outputs: [componentPort("command", captureCommandContract)],
});
export const latestTurnComponentType = defineComponentType({
  id: "link.latest-turn",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", conversationStatusContract),
    componentPort("deliveryState", deliveryPhaseAuthority.authority.presentation.contract),
    componentPort("replyState", replyPhaseAuthority.authority.presentation.contract),
  ],
  outputs: [],
});
export const composerComponentType = defineComponentType({
  id: "link.composer",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", conversationStatusContract),
    componentPort("deliveryState", deliveryPhaseAuthority.authority.presentation.contract),
    componentPort("replyState", replyPhaseAuthority.authority.presentation.contract),
  ],
  outputs: [componentPort("compose", composeTurnContract)],
});
export const activePlaybackComponentType = defineComponentType({
  id: "link.active-playback",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", playbackStatusContract),
    componentPort("playbackState", playbackPhaseAuthority.authority.presentation.contract),
  ],
  outputs: [componentPort("command", playbackCommandContract)],
});
export const connectionStatusComponentType = defineComponentType({
  id: "link.connection-status",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", sessionStatusContract),
    componentPort("connectionState", connectionStateAuthority.authority.presentation.contract),
  ],
  outputs: [],
});
export const publicLinkComponentType = defineComponentType({
  id: "link.public-link",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", sessionStatusContract),
    componentPort("connectionState", connectionStateAuthority.authority.presentation.contract),
  ],
  outputs: [],
});
export const preferencesComponentType = defineComponentType({
  id: "link.preferences",
  requiredCapabilities: componentTree,
  inputs: [componentPort("model", preferencesStatusContract)],
  outputs: [componentPort("toggle", preferenceToggleContract)],
});
export const localHistoryComponentType = defineComponentType({
  id: "link.local-history",
  requiredCapabilities: componentTree,
  inputs: [componentPort("model", historyStatusContract)],
  outputs: [],
});
export const updatesComponentType = defineComponentType({
  id: "link.updates",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", updateStatusContract),
    componentPort("updateState", updatePhaseAuthority.authority.presentation.contract),
  ],
  outputs: [componentPort("command", updateCommandContract)],
});
export const recoveryStatusComponentType = defineComponentType({
  id: "link.recovery-status",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("model", recoveryStatusContract),
    componentPort("recoveryState", recoveryPhaseAuthority.authority.presentation.contract),
  ],
  outputs: [],
});
/** The one native page host: it consumes the navigation service's active PageId. */
export const pageHostComponentType = defineComponentType({
  id: "link.page-host",
  requiredCapabilities: componentTree,
  inputs: [componentPort("activePage", activePageContract)],
  outputs: [],
});
/** A row whose only job is to emit the one typed RouteIntent. */
export const navigationEntryComponentType = defineComponentType({
  id: "link.navigation-entry",
  requiredCapabilities: componentTree,
  inputs: [],
  outputs: [componentPort("open", routeOpenContract)],
});
/** Phone-only DEV host entry; optional mounts omit it from the Wear artifact. */
export const devHostEntryComponentType = defineComponentType({
  id: "link.dev-host-entry",
  requiredCapabilities: [...componentTree, "ui.dev-host"],
  inputs: [],
  outputs: [componentPort("open", routeOpenContract)],
});
/** Self-contained CircleKit host preview; renders outside the data graph. */
export const devPreviewComponentType = defineComponentType({
  id: "link.dev-preview",
  requiredCapabilities: componentTree,
  inputs: [],
  outputs: [],
});

export const linkComponentTypes = [
  targetPickerComponentType,
  talkComponentType,
  latestTurnComponentType,
  composerComponentType,
  activePlaybackComponentType,
  connectionStatusComponentType,
  publicLinkComponentType,
  preferencesComponentType,
  localHistoryComponentType,
  updatesComponentType,
  recoveryStatusComponentType,
  pageHostComponentType,
  navigationEntryComponentType,
  devHostEntryComponentType,
  devPreviewComponentType,
] as const;

export const linkComponentInstances = [
  {
    id: "navigation.page-host", componentTypeRef: pageHostComponentType.id,
    bindings: { inputs: { activePage: "navigation.service.activePage" }, events: {} },
  },
  {
    id: "target.picker", componentTypeRef: targetPickerComponentType.id,
    bindings: {
      inputs: {
        model: "target.presentation.model",
        targetState: targetKindAuthority.presentationPortRef,
      },
      events: { select: "target.service.select" },
    },
  },
  {
    id: "capture.talk", componentTypeRef: talkComponentType.id,
    bindings: {
      inputs: {
        model: "capture.presentation.model",
        captureState: capturePhaseAuthority.presentationPortRef,
      },
      events: { command: "capture.service.command" },
    },
  },
  {
    id: "conversation.latest", componentTypeRef: latestTurnComponentType.id,
    bindings: {
      inputs: {
        model: "conversation.presentation.model",
        deliveryState: deliveryPhaseAuthority.presentationPortRef,
        replyState: replyPhaseAuthority.presentationPortRef,
      },
      events: {},
    },
  },
  {
    id: "conversation.composer", componentTypeRef: composerComponentType.id,
    bindings: {
      inputs: {
        model: "conversation.presentation.model",
        deliveryState: deliveryPhaseAuthority.presentationPortRef,
        replyState: replyPhaseAuthority.presentationPortRef,
      },
      events: { compose: "conversation.service.compose" },
    },
  },
  {
    id: "playback.controls", componentTypeRef: activePlaybackComponentType.id,
    bindings: {
      inputs: {
        model: "playback.presentation.model",
        playbackState: playbackPhaseAuthority.presentationPortRef,
      },
      events: { command: "playback.service.command" },
    },
  },
  {
    id: "session.connection", componentTypeRef: connectionStatusComponentType.id,
    bindings: {
      inputs: {
        model: "session.presentation.model",
        connectionState: connectionStateAuthority.presentationPortRef,
      },
      events: {},
    },
  },
  {
    id: "session.public-link", componentTypeRef: publicLinkComponentType.id,
    bindings: {
      inputs: {
        model: "session.presentation.model",
        connectionState: connectionStateAuthority.presentationPortRef,
      },
      events: {},
    },
  },
  {
    id: "preferences.toggles", componentTypeRef: preferencesComponentType.id,
    bindings: { inputs: { model: "preferences.presentation.model" }, events: { toggle: "preferences.service.toggle" } },
  },
  {
    id: "history.local", componentTypeRef: localHistoryComponentType.id,
    bindings: { inputs: { model: "history.presentation.model" }, events: {} },
  },
  {
    id: "updates.panel", componentTypeRef: updatesComponentType.id,
    bindings: {
      inputs: {
        model: "updates.presentation.model",
        updateState: updatePhaseAuthority.presentationPortRef,
      },
      events: { command: "updates.service.command" },
    },
  },
  {
    id: "recovery.status", componentTypeRef: recoveryStatusComponentType.id,
    bindings: {
      inputs: {
        model: "recovery.presentation.model",
        recoveryState: recoveryPhaseAuthority.presentationPortRef,
      },
      events: {},
    },
  },
  {
    id: "navigation.settings-entry", componentTypeRef: navigationEntryComponentType.id,
    bindings: {
      inputs: {},
      events: { open: "navigation.service.openSettings" },
    },
  },
  {
    id: "navigation.dev-host-entry", componentTypeRef: devHostEntryComponentType.id,
    bindings: {
      inputs: {},
      events: { open: "navigation.service.openDevHost" },
    },
  },
  {
    id: "dev.preview", componentTypeRef: devPreviewComponentType.id,
    bindings: { inputs: {}, events: {} },
  },
] as const;
