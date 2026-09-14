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

  const statusContract = {
    id: `${product}.wake-status`, kind: "state", boundary: "presentation",
    fields: [
      field("phase", finiteValueRef(phases.id)),
      field("detail", "string", { nullable: true }),
      field("detections", "integer"),
      field("phrase", finiteValueRef(phrases.id)),
    ],
  } as const;

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

  const phasePresentation = defineStatePresentation(phases, {
    id: "wake.phase",
    fields: [statePresentationField("phase", phases)],
    cases: mapFiniteCases(phases, (phase) => ({ phase })),
  });
  const phaseAuthority = defineStateAuthority({
    id: phasePresentation.id,
    source: { portRef: "wake.service.status", contract: statusContract, stateField: "phase", states: phases },
    presentation: phasePresentation,
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
  ] as const;

  const component = {
    id: "wake.status", componentTypeRef: componentType.id,
    bindings: {
      inputs: {
        model: "wake.presentation.model",
        wakeState: phaseAuthority.presentationPortRef,
        wakePhrase: phraseAuthority.presentationPortRef,
      },
      events: {},
    },
  } as const;

  return {
    phases,
    phrases,
    statusContract,
    service: wakeService,
    presentation,
    phaseAuthority,
    phraseAuthority,
    componentType,
    nodeTypes: [wakeService, presentation, phaseAuthority.adapter.type, phraseAuthority.adapter.type] as const,
    nodes,
    component,
  };
}
