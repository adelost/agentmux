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
  routeDestinationContract,
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
  navigationRouteAuthority,
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
/** A row whose only job is to open another screen; it reads the current destination. */
export const navigationEntryComponentType = defineComponentType({
  id: "link.navigation-entry",
  requiredCapabilities: componentTree,
  inputs: [
    componentPort("destination", routeDestinationContract),
    componentPort("routeState", navigationRouteAuthority.authority.presentation.contract),
  ],
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
  navigationEntryComponentType,
  devPreviewComponentType,
] as const;

export const linkComponentInstances = [
  {
    id: "target", componentTypeRef: targetPickerComponentType.id,
    bindings: {
      inputs: {
        model: "target.presentation.model",
        targetState: targetKindAuthority.authority.adapter.outputPortRef,
      },
      events: { select: "target.service.select" },
    },
  },
  {
    id: "talk", componentTypeRef: talkComponentType.id,
    bindings: {
      inputs: {
        model: "capture.presentation.model",
        captureState: capturePhaseAuthority.authority.adapter.outputPortRef,
      },
      events: { command: "capture.service.command" },
    },
  },
  {
    id: "latest", componentTypeRef: latestTurnComponentType.id,
    bindings: {
      inputs: {
        model: "conversation.presentation.model",
        deliveryState: deliveryPhaseAuthority.authority.adapter.outputPortRef,
        replyState: replyPhaseAuthority.authority.adapter.outputPortRef,
      },
      events: {},
    },
  },
  {
    id: "composer", componentTypeRef: composerComponentType.id,
    bindings: {
      inputs: {
        model: "conversation.presentation.model",
        deliveryState: deliveryPhaseAuthority.authority.adapter.outputPortRef,
        replyState: replyPhaseAuthority.authority.adapter.outputPortRef,
      },
      events: { compose: "conversation.service.compose" },
    },
  },
  {
    id: "active-playback", componentTypeRef: activePlaybackComponentType.id,
    bindings: {
      inputs: {
        model: "playback.presentation.model",
        playbackState: playbackPhaseAuthority.authority.adapter.outputPortRef,
      },
      events: { command: "playback.service.command" },
    },
  },
  {
    id: "connection", componentTypeRef: connectionStatusComponentType.id,
    bindings: {
      inputs: {
        model: "session.presentation.model",
        connectionState: connectionStateAuthority.authority.adapter.outputPortRef,
      },
      events: {},
    },
  },
  {
    id: "public-link", componentTypeRef: publicLinkComponentType.id,
    bindings: {
      inputs: {
        model: "session.presentation.model",
        connectionState: connectionStateAuthority.authority.adapter.outputPortRef,
      },
      events: {},
    },
  },
  {
    id: "preferences", componentTypeRef: preferencesComponentType.id,
    bindings: { inputs: { model: "preferences.presentation.model" }, events: { toggle: "preferences.service.toggle" } },
  },
  {
    id: "local-history", componentTypeRef: localHistoryComponentType.id,
    bindings: { inputs: { model: "history.presentation.model" }, events: {} },
  },
  {
    id: "updates", componentTypeRef: updatesComponentType.id,
    bindings: {
      inputs: {
        model: "updates.presentation.model",
        updateState: updatePhaseAuthority.authority.adapter.outputPortRef,
      },
      events: { command: "updates.service.command" },
    },
  },
  {
    id: "recovery", componentTypeRef: recoveryStatusComponentType.id,
    bindings: {
      inputs: {
        model: "recovery.presentation.model",
        recoveryState: recoveryPhaseAuthority.authority.adapter.outputPortRef,
      },
      events: {},
    },
  },
  {
    id: "settings-action", componentTypeRef: navigationEntryComponentType.id,
    bindings: {
      inputs: {
        destination: "navigation.presentation.model",
        routeState: navigationRouteAuthority.authority.adapter.outputPortRef,
      },
      events: { open: "navigation.service.openSettings" },
    },
  },
  {
    id: "dev-host", componentTypeRef: navigationEntryComponentType.id,
    bindings: {
      inputs: {
        destination: "navigation.presentation.model",
        routeState: navigationRouteAuthority.authority.adapter.outputPortRef,
      },
      events: { open: "navigation.service.openDevHost" },
    },
  },
  {
    id: "dev-preview", componentTypeRef: devPreviewComponentType.id,
    bindings: { inputs: {}, events: {} },
  },
] as const;
