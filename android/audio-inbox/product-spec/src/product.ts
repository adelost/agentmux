import {
  defineComponentCatalog,
  defineProduct,
  defineScreenComponentFamilyRegistry,
  type ProductIr,
} from "@v1d/product-spec";
import {
  LINK_ARTIFACTS,
  linkComponents,
  linkIconIds,
  linkMenuActions,
  linkPalettes,
  linkRoutes,
} from "./catalog.js";
import type { LinkNativeRegistry } from "./native-registry.js";
import { linkServiceConfigs, linkServiceMounts } from "./services.js";

const ALL_ARTIFACTS = ["phone-full-ui", "wear-full-ui"] as const;
const componentCatalog = defineComponentCatalog(linkComponents.map(({ id }) => ({ id })));
const optional = { kind: "optional", fallback: "omit" } as const;

const componentFamilies = defineScreenComponentFamilyRegistry(componentCatalog, [
  {
    screen: "home",
    family: {
      id: "link.home",
      trees: [
        { surface: "round", mounts: [
          { component: "target", region: "content" },
          { component: "talk", region: "content" },
          { component: "latest", region: "content" },
        ] },
        { surface: "compact", mounts: [
          { component: "target", region: "content" },
          { component: "latest", region: "content" },
          { component: "composer", region: "footer" },
          { component: "talk", region: "footer" },
        ] },
        { surface: "wide", mounts: [
          { component: "target", region: "rail" },
          { component: "latest", region: "content" },
          { component: "composer", region: "footer" },
          { component: "talk", region: "footer" },
        ] },
      ],
    },
  },
  {
    screen: "settings",
    family: {
      id: "link.settings",
      trees: [
        { surface: "round", mounts: [
          { component: "connection", region: "content" },
          { component: "updates", region: "content" },
          { component: "dev-host", region: "content", requirement: optional },
          { component: "recovery", region: "content", requirement: optional },
        ] },
        { surface: "compact", mounts: [
          { component: "active-playback", region: "content", requirement: optional },
          { component: "connection", region: "content" },
          { component: "public-link", region: "content" },
          { component: "preferences", region: "content" },
          { component: "local-history", region: "content" },
          { component: "updates", region: "content" },
          { component: "dev-host", region: "content" },
          { component: "recovery", region: "content", requirement: optional },
        ] },
        { surface: "wide", mounts: [
          { component: "active-playback", region: "rail", requirement: optional },
          { component: "connection", region: "content" },
          { component: "public-link", region: "content" },
          { component: "preferences", region: "content" },
          { component: "local-history", region: "content" },
          { component: "updates", region: "content" },
          { component: "dev-host", region: "content" },
          { component: "recovery", region: "content", requirement: optional },
        ] },
      ],
    },
  },
  {
    screen: "dev-host",
    family: {
      id: "link.dev-host",
      trees: ["round", "compact", "wide"].map((surface) => ({
        surface: surface as "round" | "compact" | "wide",
        mounts: [{ component: "dev-preview", region: "content" }],
      })),
    },
  },
]);

const baseProduct = defineProduct({
  id: "agentmux-link",
  rendererBindings: [
    { id: "android-phone-compose", capabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
    { id: "android-wear-compose", capabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
  ],
  artifacts: [
    { id: "phone-full-ui", rendererRefs: ["android-phone-compose"], requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
    { id: "wear-full-ui", rendererRefs: ["android-wear-compose"], requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
  ],
  legos: {
    id: "agentmux-link.graph",
    configs: linkServiceConfigs,
    mounts: linkServiceMounts,
    wiring: [
      { from: "capture.captured", to: "delivery.turn" },
      { from: "delivery.accepted", to: "reply.accepted" },
      { from: "reply.reply", to: "playback.reply" },
    ],
  },
  componentCatalog,
  componentFamilies,
  ui: [
    { id: "link.navigation", kind: "menu-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.menu", "ui.navigation"], ports: { state: "navigation.destination", action: "navigation.open" } },
    { id: "link.capture", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "capture.status", action: "capture.command" } },
    { id: "link.delivery", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "delivery.status" } },
    { id: "link.reply", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "reply.status" } },
    { id: "link.playback", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "playback.status", action: "playback.command" } },
  ],
});

export interface AgentmuxLinkProductIr extends ProductIr {
  readonly productSpecVersion: string;
  readonly link: {
    readonly artifacts: typeof LINK_ARTIFACTS;
    readonly routes: typeof linkRoutes;
    readonly menuActions: typeof linkMenuActions;
    readonly components: typeof linkComponents;
    readonly palettes: typeof linkPalettes;
    readonly nativeServices: LinkNativeRegistry["services"];
  };
}

export function compileAgentmuxLinkProduct(
  registry: LinkNativeRegistry,
  productSpecVersion: string,
): AgentmuxLinkProductIr {
  if (productSpecVersion.trim() === "") throw new Error("ProductSpec package version is blank");
  requireCatalogSound();
  requireNativeParity(registry);
  return {
    ...baseProduct,
    productSpecVersion,
    link: {
      artifacts: LINK_ARTIFACTS,
      routes: linkRoutes,
      menuActions: linkMenuActions,
      components: linkComponents,
      palettes: linkPalettes,
      nativeServices: registry.services,
    },
  };
}

function requireCatalogSound(): void {
  const artifacts = new Set(LINK_ARTIFACTS.map(({ id }) => id));
  const routes = new Set(linkRoutes.map(({ id }) => id));
  requireUnique([...artifacts], "artifact id");
  requireUnique([...routes], "route id");
  for (const artifact of LINK_ARTIFACTS) requireUnique(artifact.surfaces, `surface in '${artifact.id}'`);
  for (const item of [...linkRoutes, ...linkMenuActions, ...linkComponents, ...linkPalettes]) {
    for (const artifact of item.artifacts) {
      if (!artifacts.has(artifact)) throw new Error(`'${item.id}' uses missing artifact '${artifact}'`);
    }
  }
  for (const action of linkMenuActions) {
    if (!routes.has(action.destination)) throw new Error(`action '${action.id}' uses missing route '${action.destination}'`);
    if (action.a11y.trim() === "") throw new Error(`action '${action.id}' has blank accessibility copy`);
    if (action.rowId.trim() === "") throw new Error(`action '${action.id}' has blank row id`);
  }
}

function requireNativeParity(registry: LinkNativeRegistry): void {
  requireExactSet(new Set(LINK_ARTIFACTS.map(({ id }) => id)), new Set(registry.profiles), "profile/native binding");
  requireExactSet(new Set(linkIconIds), new Set(registry.icons.map(({ iconId }) => iconId)), "icon/native binding");
  requireExactSet(new Set(linkPalettes.map(({ id }) => id)), new Set(registry.palettes.map(({ paletteId }) => paletteId)), "palette/native binding");
  requireUnique(registry.components.map(({ componentId }) => componentId), "native component id");
  requireExactSet(new Set(linkComponents.map(({ id }) => id)), new Set(registry.components.map(({ componentId }) => componentId)), "component/native binding");
  for (const component of linkComponents) {
    const native = registry.components.find(({ componentId }) => componentId === component.id);
    if (native?.rendererId !== component.rendererId) throw new Error(`component '${component.id}' renderer drift`);
    requireExactSet(new Set(component.artifacts), new Set(native?.profiles ?? []), `component '${component.id}' profile`);
  }
  const mounts = baseProduct.legos.mounts;
  requireExactSet(new Set(mounts.map(({ id }) => id)), new Set(registry.services.map(({ serviceId }) => serviceId)), "service/native binding");
  for (const service of registry.services) {
    const mounted = mounts.find(({ id }) => id === service.serviceId);
    if (mounted === undefined) throw new Error(`orphan native service '${service.serviceId}'`);
    requireExactSet(new Set(mounted.lego.inputs.map(({ id }) => id)), new Set(service.inputPorts), `service '${service.serviceId}' input`);
    requireExactSet(new Set(mounted.lego.outputs.map(({ id }) => id)), new Set(service.outputPorts), `service '${service.serviceId}' output`);
    requireExactSet(new Set(ALL_ARTIFACTS), new Set(service.profiles), `service '${service.serviceId}' profile`);
  }
  for (const palette of linkPalettes) {
    const native = registry.palettes.find(({ paletteId }) => paletteId === palette.id);
    requireExactSet(new Set(palette.artifacts), new Set(native?.profiles ?? []), `palette '${palette.id}' profile`);
  }
}

function requireExactSet(left: ReadonlySet<string>, right: ReadonlySet<string>, owner: string): void {
  const missing = [...left].filter((id) => !right.has(id));
  const orphan = [...right].filter((id) => !left.has(id));
  if (missing.length > 0) throw new Error(`${owner} missing '${missing.join("', '")}'`);
  if (orphan.length > 0) throw new Error(`${owner} orphan '${orphan.join("', '")}'`);
}
function requireUnique(values: readonly string[], owner: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${owner}`);
}
