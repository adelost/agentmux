import { configInput, port, present, service, type LegoContract } from "@v1d/product-spec";
import {
  captureCommandContract,
  capturedTurnContract,
  captureStatusContract,
  composeTurnContract,
  editComposerContract,
  conversationStatusContract,
  historyStatusContract,
  playbackCommandContract,
  playbackStatusContract,
  openAttachmentContract,
  preferenceToggleContract,
  preferencesStatusContract,
  recoveryStatusContract,
  activePageContract,
  routeOpenContract,
  sessionStatusContract,
  publicLinkCommandContract,
  targetDirectoryContract,
  targetSelectContract,
  updateCommandContract,
  updateStatusContract,
  devPreviewStatusContract,
  navigationBackContract,
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

const runtime = <
  const ContextInputs extends readonly string[],
  const Effects extends readonly string[],
>(
  stateOwner: "none" | "instance" | "external",
  lifetime: "call" | "operation" | "instance" | "process",
  durability: "transient" | "durable",
  clockDomain: "none" | "monotonic" | "wall",
  contextInputs: ContextInputs,
  effects: Effects,
) => ({ stateOwner, lifetime, durability, clockDomain, contextInputs, effects });

/**
 * One typed navigation input per emitting component: a generated input has
 * exactly one upstream output, so the settings row and the dev-host row each
 * get their own port instead of sharing a ambiguous one.
 */
export const navigationService = service({
  id: "link.navigation",
  inputs: [
    port("openSettings", routeOpenContract), port("openDevHost", routeOpenContract),
    port("back", navigationBackContract),
  ],
  outputs: [port("activePage", activePageContract)],
  runtime: runtime("instance", "instance", "transient", "none", [], ["navigation.route-state"]),
} as const);

export const captureService = service({
  id: "link.capture",
  inputs: [port("command", captureCommandContract)],
  outputs: [port("status", captureStatusContract), port("captured", capturedTurnContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "operation", "durable", "monotonic", ["microphone.permission"], ["audio.capture", "storage.write"]),
} as const);

export const conversationService = service({
  id: "link.conversation",
  inputs: [port("turn", capturedTurnContract), port("compose", composeTurnContract), port("edit", editComposerContract)],
  outputs: [port("status", conversationStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);

export const playbackService = service({
  id: "link.playback",
  inputs: [port("command", playbackCommandContract), port("latestCommand", playbackCommandContract)],
  outputs: [port("status", playbackStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

/** Owns the tailnet/public route table; route policy math stays native. */
export const targetDirectoryService = service({
  id: "link.target-directory",
  inputs: [port("select", targetSelectContract)],
  outputs: [port("directory", targetDirectoryContract)],
  runtime: runtime("instance", "process", "durable", "none", ["transport.route-policy"], ["storage.write"]),
} as const);

/** Public mailbox session and connection truth; polling and auth transports stay native. */
export const sessionService = service({
  id: "link.session",
  inputs: [port("command", publicLinkCommandContract)],
  outputs: [port("status", sessionStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity", "keystore.session"], ["transport.poll", "transport.auth"]),
} as const);

/** Platform URL launch stays behind an effect-owning host service, never in a renderer. */
export const hostEffectService = service({
  id: "link.host-effect",
  inputs: [port("openAttachment", openAttachmentContract)],
  outputs: [],
  runtime: runtime("external", "process", "transient", "none", [], ["host.open-uri"]),
} as const);

export const devPreviewService = service({
  id: "link.dev-preview",
  inputs: [],
  outputs: [port("status", devPreviewStatusContract)],
  runtime: runtime("external", "process", "transient", "none", ["dev.inspection"], ["dev.render"]),
} as const);

/** Local history retention truth; the retention policy constant stays native. */
export const historyService = service({
  id: "link.history",
  inputs: [],
  outputs: [port("status", historyStatusContract)],
  runtime: runtime("external", "process", "durable", "none", [], ["storage.read"]),
} as const);

/** Durable user preferences behind typed toggles; SharedPreferences stays native. */
export const preferencesService = service({
  id: "link.preferences",
  inputs: [port("toggle", preferenceToggleContract)],
  outputs: [port("status", preferencesStatusContract)],
  runtime: runtime("external", "process", "durable", "none", ["storage.preferences"], ["storage.write"]),
} as const);

/** Release check and install flow; manifest verification and APK handling stay native. */
export const updatesService = service({
  id: "link.updates",
  inputs: [port("command", updateCommandContract)],
  outputs: [port("status", updateStatusContract)],
  runtime: runtime("instance", "process", "transient", "wall", ["network.connectivity"], ["network.fetch", "apk.install"]),
} as const);

/** State-repository recovery truth; quarantine mechanics stay native. */
export const recoveryService = service({
  id: "link.recovery",
  inputs: [],
  outputs: [port("status", recoveryStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["storage.state-repository"], ["storage.read"]),
} as const);

const presentation = <const Id extends string, const Contract extends LegoContract>(
  id: Id,
  contract: Contract,
) => present({
  id,
  inputs: [port("source", contract)],
  outputs: [port("model", contract)],
  runtime: runtime("none", "call", "transient", "none", [], []),
} as const);

export const capturePresentation = presentation("link.present.capture", captureStatusContract);
export const conversationPresentation = presentation("link.present.conversation", conversationStatusContract);
export const playbackPresentation = presentation("link.present.playback", playbackStatusContract);
export const targetPresentation = presentation("link.present.target", targetDirectoryContract);
export const sessionPresentation = presentation("link.present.session", sessionStatusContract);
export const historyPresentation = presentation("link.present.history", historyStatusContract);
export const preferencesPresentation = presentation("link.present.preferences", preferencesStatusContract);
export const updatesPresentation = presentation("link.present.updates", updateStatusContract);
export const recoveryPresentation = presentation("link.present.recovery", recoveryStatusContract);
export const devPreviewPresentation = presentation("link.present.dev-preview", devPreviewStatusContract);

export const linkNodeTypes = [
  navigationService,
  captureService,
  conversationService,
  playbackService,
  targetDirectoryService,
  sessionService,
  historyService,
  preferencesService,
  updatesService,
  recoveryService,
  hostEffectService,
  devPreviewService,
  capturePresentation,
  conversationPresentation,
  playbackPresentation,
  targetPresentation,
  sessionPresentation,
  historyPresentation,
  preferencesPresentation,
  updatesPresentation,
  recoveryPresentation,
  devPreviewPresentation,
  capturePhaseAuthority.adapter.type,
  deliveryPhaseAuthority.adapter.type,
  replyPhaseAuthority.adapter.type,
  playbackPhaseAuthority.adapter.type,
  targetKindAuthority.adapter.type,
  connectionStateAuthority.adapter.type,
  updatePhaseAuthority.adapter.type,
  recoveryPhaseAuthority.adapter.type,
] as const;
