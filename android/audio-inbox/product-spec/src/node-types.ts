import { configInput, port, present, service, type LegoContract } from "@v1d/product-spec";
import {
  captureCommandContract,
  capturedTurnContract,
  captureStatusContract,
  composeTurnContract,
  conversationStatusContract,
  historyClearContract,
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
import { linkWakeWord } from "./link-wake-word.js";

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
/**
 * WHAT: Routes typed page intents and publishes the active page.
 * WHY: Keeps navigation state separate from component controls and screen-specific logic.
 */
export const navigationService = service({
  id: "link.navigation",
  inputs: [
    port("openSettings", routeOpenContract),
    port("openDevHost", routeOpenContract),
    port("openWakeDebug", routeOpenContract),
    port("openWakeTry", routeOpenContract),
  ],
  outputs: [port("activePage", activePageContract)],
  runtime: runtime("instance", "instance", "transient", "none", [], ["navigation.route-state"]),
} as const);

/**
 * WHAT: Collects one voice turn and publishes capture state and completed audio.
 * WHY: Keeps microphone and durable capture effects outside conversation and presentation code.
 */
export const captureService = service({
  id: "link.capture",
  inputs: [port("command", captureCommandContract)],
  outputs: [port("status", captureStatusContract), port("captured", capturedTurnContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "operation", "durable", "monotonic", ["microphone.permission"], ["audio.capture", "storage.write"]),
} as const);

/**
 * WHAT: Dispatches captured and composed turns through the conversation transport lifecycle.
 * WHY: Keeps durable delivery and retry ownership separate from capture and presentation.
 */
export const conversationService = service({
  id: "link.conversation",
  inputs: [port("turn", capturedTurnContract), port("compose", composeTurnContract)],
  outputs: [port("status", conversationStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity"], ["storage.write", "transport.send", "transport.receive", "retry.schedule"]),
} as const);

/**
 * WHAT: Routes playback commands and publishes the current playback state.
 * WHY: Keeps audio focus and playback effects outside UI controls and conversation state.
 */
export const playbackService = service({
  id: "link.playback",
  inputs: [port("command", playbackCommandContract)],
  outputs: [port("status", playbackStatusContract)],
  configInputs: [configInput("policy")],
  runtime: runtime("external", "process", "transient", "monotonic", ["audio.focus"], ["audio.playback"]),
} as const);

/** Owns the tailnet/public route table; route policy math stays native. */
/**
 * WHAT: Stores selectable conversation targets and publishes the active directory.
 * WHY: Keeps route policy and persistence separate from conversation delivery.
 */
export const targetDirectoryService = service({
  id: "link.target-directory",
  inputs: [port("select", targetSelectContract)],
  outputs: [port("directory", targetDirectoryContract)],
  runtime: runtime("instance", "process", "durable", "none", ["transport.route-policy"], ["storage.write"]),
} as const);

/** Public mailbox session and connection truth; polling and auth transports stay native. */
/**
 * WHAT: Tracks public mailbox session and connection state.
 * WHY: Keeps authentication and polling transport details outside presentation and conversation code.
 */
export const sessionService = service({
  id: "link.session",
  inputs: [],
  outputs: [port("status", sessionStatusContract)],
  runtime: runtime("external", "process", "durable", "wall", ["network.connectivity", "keystore.session"], ["transport.poll", "transport.auth"]),
} as const);

/** Local history retention truth and its one clear; the retention policy constant stays native. */
/**
 * WHAT: Stores local conversation history and applies the explicit clear command.
 * WHY: Keeps retention and persistence ownership separate from presentation and transport.
 */
export const historyService = service({
  id: "link.history",
  inputs: [port("clear", historyClearContract)],
  outputs: [port("status", historyStatusContract)],
  runtime: runtime("external", "process", "durable", "none", [], ["storage.read", "storage.write"]),
} as const);

/** Durable user preferences behind typed toggles; SharedPreferences stays native. */
/**
 * Two controls can ask for a preference to change: the list in Settings and the wake word's own control on
 * the main page. A service input takes exactly one upstream, so each names its own, and the service stays
 * the single place that writes the stored preference.
 */
/**
 * WHAT: Stores user preferences behind typed toggle inputs and status output.
 * WHY: Keeps persistence ownership separate from settings controls and wake-word presentation.
 */
export const preferencesService = service({
  id: "link.preferences",
  inputs: [port("toggle", preferenceToggleContract), port("wakeToggle", preferenceToggleContract)],
  outputs: [port("status", preferencesStatusContract)],
  runtime: runtime("external", "process", "durable", "none", ["storage.preferences"], ["storage.write"]),
} as const);

/** Release check and install flow; manifest verification and APK handling stay native. */
/**
 * WHAT: Fetches release status and routes explicit update commands through installation.
 * WHY: Keeps manifest verification and APK effects outside settings presentation.
 */
export const updatesService = service({
  id: "link.updates",
  inputs: [port("command", updateCommandContract)],
  outputs: [port("status", updateStatusContract)],
  runtime: runtime("instance", "process", "transient", "wall", ["network.connectivity"], ["network.fetch", "apk.install"]),
} as const);

/** State-repository recovery truth; quarantine mechanics stay native. */
/**
 * WHAT: Reports recovery state from the persistent conversation repository.
 * WHY: Keeps quarantine and recovery mechanics outside normal conversation presentation.
 */
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
  capturePresentation,
  conversationPresentation,
  playbackPresentation,
  targetPresentation,
  sessionPresentation,
  historyPresentation,
  preferencesPresentation,
  updatesPresentation,
  recoveryPresentation,
  capturePhaseAuthority.adapter.type,
  deliveryPhaseAuthority.adapter.type,
  replyPhaseAuthority.adapter.type,
  playbackPhaseAuthority.adapter.type,
  targetKindAuthority.adapter.type,
  connectionStateAuthority.adapter.type,
  updatePhaseAuthority.adapter.type,
  recoveryPhaseAuthority.adapter.type,
  ...linkWakeWord.nodeTypes,
] as const;
