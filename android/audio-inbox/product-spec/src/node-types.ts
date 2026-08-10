import { configInput, port, present, service, type LegoContract } from "@v1d/product-spec";
import {
  captureCommandContract,
  capturedTurnContract,
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
  inputs: [port("openSettings", routeOpenContract), port("openDevHost", routeOpenContract)],
  outputs: [port("destination", routeDestinationContract)],
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
  inputs: [port("turn", capturedTurnContract), port("compose", composeTurnContract)],
  outputs: [port("status", conversationStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);

export const playbackService = service({
  id: "link.playback",
  inputs: [port("command", playbackCommandContract)],
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
  inputs: [],
  outputs: [port("status", sessionStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity", "keystore.session"], ["transport.poll", "transport.auth"]),
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

export const navigationPresentation = presentation("link.present.navigation", routeDestinationContract);
export const capturePresentation = presentation("link.present.capture", captureStatusContract);
export const conversationPresentation = presentation("link.present.conversation", conversationStatusContract);
export const playbackPresentation = presentation("link.present.playback", playbackStatusContract);
export const targetPresentation = presentation("link.present.target", targetDirectoryContract);
export const sessionPresentation = presentation("link.present.session", sessionStatusContract);
export const historyPresentation = presentation("link.present.history", historyStatusContract);
export const preferencesPresentation = presentation("link.present.preferences", preferencesStatusContract);
export const updatesPresentation = presentation("link.present.updates", updateStatusContract);
export const recoveryPresentation = presentation("link.present.recovery", recoveryStatusContract);

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
  navigationPresentation,
  capturePresentation,
  conversationPresentation,
  playbackPresentation,
  targetPresentation,
  sessionPresentation,
  historyPresentation,
  preferencesPresentation,
  updatesPresentation,
  recoveryPresentation,
  navigationRouteAuthority.adapter.type,
  capturePhaseAuthority.adapter.type,
  deliveryPhaseAuthority.adapter.type,
  replyPhaseAuthority.adapter.type,
  playbackPhaseAuthority.adapter.type,
  targetKindAuthority.adapter.type,
  connectionStateAuthority.adapter.type,
  updatePhaseAuthority.adapter.type,
  recoveryPhaseAuthority.adapter.type,
] as const;
