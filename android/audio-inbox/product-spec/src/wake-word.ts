import {
  componentPort,
  defineComponentType,
  defineStateAuthority,
  defineStatePresentation,
  field,
  finiteValueRef,
  finiteValues,
  mapFiniteCases,
  port,
  present,
  service,
  statePresentationField,
} from "@v1d/product-spec";

/**
 * Hands-free wake word as one declared building block: the phase vocabulary,
 * the status contract, a process-lived service, its presentation, the phase
 * authority, a status component and the node/component instances.
 *
 * Nothing here names a Link type. A product calls `defineWakeWordFeature` with
 * its id prefix and spreads the parts into its own lists; the native half is
 * the app-agnostic `:wakeword` module. The service owns the microphone loop
 * and hands a finished question to the product's own conversation owner
 * natively, because the loop must keep working with no UI graph mounted.
 */
export const WAKE_WORD_CONTEXT_INPUTS = ["microphone.permission", "audio.focus", "wake-word.model"] as const;
export const WAKE_WORD_EFFECTS = ["audio.capture", "storage.write", "transport.send"] as const;

export function defineWakeWordFeature<const Product extends string>(product: Product) {
  const phases = finiteValues(`${product}.wake-phase`, [
    "off", "listening", "capturing", "sending", "thinking", "speaking", "blocked",
  ]);
  // The phrases whose models ship in `:wakeword` (WakePhrases.offered), default first.
  const phrases = finiteValues(`${product}.wake-phrase`, ["hey-jarvis", "hey-marvin", "alexa"]);
  /**
   * How eagerly the wake word answers. Three steps with a word each, not a confidence slider: a raw
   * threshold called "sensitivity" runs backwards to its own name, higher meaning less sensitive.
   * The vocabulary is declared here; what each step does to the threshold and the rule is measured and
   * lives beside the models in `:wakeword` (WakeSensitivity), exactly as a phrase's threshold does.
   */
  const sensitivities = finiteValues(`${product}.wake-sensitivity`, ["strict", "normal", "eager"]);

  const statusContract = {
    id: `${product}.wake-status`, kind: "state", boundary: "presentation",
    fields: [
      field("phase", finiteValueRef(phases.id)),
      field("detail", "string", { nullable: true }),
      field("detections", "integer"),
      field("phrase", finiteValueRef(phrases.id)),
      field("sensitivity", finiteValueRef(sensitivities.id)),
    ],
  } as const;

  /**
   * WHAT: Tracks hands-free wake activity and publishes its user-visible status.
   * WHY: Keeps microphone-loop and transport effects independent from mounted UI graphs.
   */
  const wakeService = service({
    id: `${product}.wake`,
    inputs: [],
    outputs: [port("status", statusContract)],
    runtime: {
      stateOwner: "external", lifetime: "process", durability: "transient", clockDomain: "monotonic",
      contextInputs: WAKE_WORD_CONTEXT_INPUTS, effects: WAKE_WORD_EFFECTS,
    },
  } as const);

  const presentation = present({
    id: `${product}.present.wake`,
    inputs: [port("source", statusContract)],
    outputs: [port("model", statusContract)],
    runtime: {
      stateOwner: "none", lifetime: "call", durability: "transient", clockDomain: "none",
      contextInputs: [], effects: [],
    },
  } as const);

  /**
   * Which glyph a phase wears, on any surface that has room for one. Three, not seven: a glyph shows a
   * shape, not a state machine. Mattias 2026-09-19 read the old one, the system's "speak now" microphone,
   * as Link hearing him all the time, so waiting is the quietest of the three and never the loudest.
   * THINKING travels with SPEAKING because both are the answer half of a turn. BLOCKED is alone in
   * ATTENTION: it is the one phase that needs a person to do something, and a row that says so has to look
   * unlike the three that are only reporting. A status bar never shows it in practice, because a blocked
   * loop has no service to post one.
   * Named for the phase rather than for the notification: the status bar was the first surface to wear
   * these, the main page's row is the second, and one grouping decides for both, so no surface picks a
   * glyph of its own (lsrc:0, 2026-09-19).
   */
  const phaseGlyphs = finiteValues(`${product}.wake-glyph`, ["waiting", "hearing", "speaking", "attention"]);
  const phaseGlyph = {
    off: "waiting", listening: "waiting",
    capturing: "hearing", sending: "hearing",
    thinking: "speaking", speaking: "speaking",
    blocked: "attention",
  } as const;

  // One word per phase, for a control with no room for a sentence. Declared rather than typed beside the
  // control, so the word a wearer reads on the main page cannot drift from the phase the loop is in.
  // "hearing" rather than "capturing": what the phase is called inside is not what it is called out loud.
  const phaseWords = {
    off: "OFF", listening: "LISTENING", capturing: "HEARING", sending: "SENDING",
    thinking: "THINKING", speaking: "SPEAKING", blocked: "BLOCKED",
  } as const;
  const phasePresentation = defineStatePresentation(phases, {
    id: "wake.phase",
    fields: [
      statePresentationField("phase", phases),
      statePresentationField("word", "string"),
      statePresentationField("glyph", phaseGlyphs),
    ],
    cases: mapFiniteCases(phases, (phase) => ({
      phase, word: phaseWords[phase], glyph: phaseGlyph[phase],
    })),
  });
  const phaseAuthority = defineStateAuthority({
    id: phasePresentation.id,
    source: { portRef: "wake.service.status", contract: statusContract, stateField: "phase", states: phases },
    presentation: phasePresentation,
  });

  /** One word and one sentence per step, so what a wearer reads is declared beside what the step is. */
  const sensitivityCopy = {
    strict: { word: "STRICT", hint: "Fewer false wakes, and it may miss you" },
    normal: { word: "NORMAL", hint: "What each phrase was measured at" },
    eager: { word: "EAGER", hint: "For a voice it keeps missing" },
  } as const;
  const sensitivityPresentation = defineStatePresentation(sensitivities, {
    id: "wake.sensitivity",
    fields: [
      statePresentationField("sensitivity", sensitivities),
      statePresentationField("word", "string"),
      statePresentationField("hint", "string"),
    ],
    cases: mapFiniteCases(sensitivities, (step) => ({ sensitivity: step, ...sensitivityCopy[step] })),
  });
  const sensitivityAuthority = defineStateAuthority({
    id: sensitivityPresentation.id,
    source: {
      portRef: "wake.service.status", contract: statusContract,
      stateField: "sensitivity", states: sensitivities,
    },
    presentation: sensitivityPresentation,
  });

  const phrasePresentation = defineStatePresentation(phrases, {
    id: "wake.phrase",
    fields: [statePresentationField("phrase", phrases)],
    cases: mapFiniteCases(phrases, (phrase) => ({ phrase })),
  });
  const phraseAuthority = defineStateAuthority({
    id: phrasePresentation.id,
    source: { portRef: "wake.service.status", contract: statusContract, stateField: "phrase", states: phrases },
    presentation: phrasePresentation,
  });

  const componentType = defineComponentType({
    id: `${product}.wake-word`,
    requiredCapabilities: ["ui.component-tree"],
    inputs: [
      componentPort("model", statusContract),
      componentPort("wakeState", phaseAuthority.authority.presentation.contract),
      componentPort("wakePhrase", phraseAuthority.authority.presentation.contract),
      componentPort("wakeSensitivity", sensitivityAuthority.authority.presentation.contract),
    ],
    outputs: [],
  });

  const nodes = [
    {
      id: "wake.service", nodeTypeRef: wakeService.id,
      config: {}, bindings: {},
      activation: { kind: "lifetime", lifecycleSources: [] },
    },
    {
      id: "wake.presentation", nodeTypeRef: presentation.id,
      config: {}, bindings: { source: "wake.service.status" },
    },
    phaseAuthority.adapter.node,
    phraseAuthority.adapter.node,
    sensitivityAuthority.adapter.node,
  ] as const;

  const component = {
    id: "wake.status", componentTypeRef: componentType.id,
    bindings: {
      inputs: {
        model: "wake.presentation.model",
        wakeState: phaseAuthority.presentationPortRef,
        wakePhrase: phraseAuthority.presentationPortRef,
        wakeSensitivity: sensitivityAuthority.presentationPortRef,
      },
      events: {},
    },
  } as const;

  return {
    phases,
    phrases,
    sensitivities,
    phaseGlyphs,
    statusContract,
    service: wakeService,
    presentation,
    phaseAuthority,
    phraseAuthority,
    sensitivityAuthority,
    componentType,
    nodeTypes: [
      wakeService, presentation, phaseAuthority.adapter.type, phraseAuthority.adapter.type,
      sensitivityAuthority.adapter.type,
    ] as const,
    nodes,
    component,
  };
}
