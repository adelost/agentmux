import { configInput, defineLegoSpec, port } from "@v1d/product-spec";
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

const runtime = (
  stateOwner: "none" | "instance" | "external",
  lifetime: "call" | "operation" | "instance" | "process",
  durability: "transient" | "durable",
  clockDomain: "none" | "monotonic" | "wall",
  contextInputs: readonly string[],
  effects: readonly string[],
) => ({ stateOwner, lifetime, durability, clockDomain, contextInputs, effects });

/**
 * One typed navigation input per emitting component: a generated input has
 * exactly one upstream output, so the settings row and the dev-host row each
 * get their own port instead of sharing a ambiguous one.
 */
export const navigationService = defineLegoSpec({
  id: "link.navigation", role: "adapter",
  inputs: [port("openSettings", routeOpenContract), port("openDevHost", routeOpenContract)],
  outputs: [port("destination", routeDestinationContract)],
  runtime: runtime("instance", "instance", "transient", "none", [], []),
} as const);

export const captureService = defineLegoSpec({
  id: "link.capture", role: "source",
  inputs: [port("command", captureCommandContract)],
  outputs: [port("status", captureStatusContract), port("captured", capturedTurnContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "operation", "durable", "monotonic", ["microphone.permission"], ["audio.capture", "storage.write"]),
} as const);

export const conversationService = defineLegoSpec({
  id: "link.conversation", role: "adapter",
  inputs: [port("turn", capturedTurnContract), port("compose", composeTurnContract)],
  outputs: [port("status", conversationStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);

export const playbackService = defineLegoSpec({
  id: "link.playback", role: "consumer",
  inputs: [port("command", playbackCommandContract)],
  outputs: [port("status", playbackStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

/** Owns the tailnet/public route table; route policy math stays native. */
export const targetDirectoryService = defineLegoSpec({
  id: "link.target-directory", role: "adapter",
  inputs: [port("select", targetSelectContract)],
  outputs: [port("directory", targetDirectoryContract)],
  runtime: runtime("instance", "process", "durable", "none", ["transport.route-policy"], ["storage.write"]),
} as const);

/** Public mailbox session and connection truth; polling and auth transports stay native. */
export const sessionService = defineLegoSpec({
  id: "link.session", role: "adapter",
  inputs: [],
  outputs: [port("status", sessionStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity", "keystore.session"], ["transport.poll", "transport.auth"]),
} as const);

/** Local history retention truth; the retention policy constant stays native. */
export const historyService = defineLegoSpec({
  id: "link.history", role: "adapter",
  inputs: [],
  outputs: [port("status", historyStatusContract)],
  runtime: runtime("external", "process", "durable", "none", [], []),
} as const);

/** Durable user preferences behind typed toggles; SharedPreferences stays native. */
export const preferencesService = defineLegoSpec({
  id: "link.preferences", role: "adapter",
  inputs: [port("toggle", preferenceToggleContract)],
  outputs: [port("status", preferencesStatusContract)],
  runtime: runtime("external", "process", "durable", "none", ["storage.preferences"], ["storage.write"]),
} as const);

/** Release check and install flow; manifest verification and APK handling stay native. */
export const updatesService = defineLegoSpec({
  id: "link.updates", role: "adapter",
  inputs: [port("command", updateCommandContract)],
  outputs: [port("status", updateStatusContract)],
  runtime: runtime("instance", "process", "transient", "wall", ["network.connectivity"], ["network.fetch", "apk.install"]),
} as const);

/** State-repository recovery truth; quarantine mechanics stay native. */
export const recoveryService = defineLegoSpec({
  id: "link.recovery", role: "source",
  inputs: [],
  outputs: [port("status", recoveryStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["storage.state-repository"], []),
} as const);

export const linkServiceTypes = [
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
] as const;
