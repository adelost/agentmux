import {
  defineComponentCatalog,
  defineProduct,
  defineScreenComponentFamilyRegistry,
  type ProductIr,
} from "@v1d/product-spec";
import { CIRCLEKIT_ASSET_CATALOG } from "@v1d/circlekit-assets";
import {
  linkMenuActions,
  linkRoutes,
} from "./catalog.js";
import type { LinkNativeRegistry } from "./native-registry.js";
import { linkServiceConfigs, linkServiceMounts } from "./services.js";

const ALL_ARTIFACTS = ["phone-full-ui", "wear-full-ui"] as const;
const componentCatalog = defineComponentCatalog([
  { id: "target" }, { id: "latest" }, { id: "composer" }, { id: "talk" },
  { id: "active-playback" }, { id: "connection" }, { id: "public-link" },
  { id: "preferences" }, { id: "local-history" }, { id: "updates" },
  { id: "dev-host" }, { id: "recovery" }, { id: "dev-preview" },
]);
const optional = { kind: "optional", fallback: "omit" } as const;
const linkPalette = { variants: [] } as const;

const iconRefs = [
  { id: "route.home", assetRef: "link", artifacts: ALL_ARTIFACTS },
  { id: "route.settings", assetRef: "gear", artifacts: ALL_ARTIFACTS },
  { id: "route.dev-host", assetRef: "phone", artifacts: ["phone-full-ui"] },
  { id: "action.open-settings", assetRef: "gear", artifacts: ALL_ARTIFACTS },
  { id: "component.target", assetRef: "target", artifacts: ALL_ARTIFACTS },
  { id: "component.latest", assetRef: "speaker", artifacts: ALL_ARTIFACTS },
  { id: "component.composer", assetRef: "pencil", artifacts: ["phone-full-ui"] },
  { id: "component.talk", assetRef: "record", artifacts: ALL_ARTIFACTS },
  { id: "component.active-playback", assetRef: "play", artifacts: ["phone-full-ui"] },
  { id: "component.connection", assetRef: "wifi", artifacts: ALL_ARTIFACTS },
  { id: "component.public-link", assetRef: "link", artifacts: ["phone-full-ui"] },
  { id: "component.preferences", assetRef: "speaker", artifacts: ["phone-full-ui"] },
  { id: "component.local-history", assetRef: "activity", artifacts: ["phone-full-ui"] },
  { id: "component.updates", assetRef: "download", artifacts: ALL_ARTIFACTS },
  { id: "component.dev-host", assetRef: "phone", artifacts: ["phone-full-ui"] },
  { id: "component.recovery", assetRef: "warning", artifacts: ALL_ARTIFACTS },
  { id: "component.dev-preview", assetRef: "phone", artifacts: ["phone-full-ui"] },
] as const;

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
    { id: "phone-full-ui", rendererRefs: ["android-phone-compose"], requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"], entryScreen: "home", serves: ["round", "compact", "wide"] },
    { id: "wear-full-ui", rendererRefs: ["android-wear-compose"], requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"], entryScreen: "home", serves: ["round"] },
  ],
  legos: {
    id: "agentmux-link.graph",
    configs: linkServiceConfigs,
    mounts: linkServiceMounts,
    wiring: [
      { from: "capture.captured", to: "conversation.turn" },
    ],
  },
  componentCatalog,
  componentFamilies,
  palette: linkPalette,
  assetCatalogRef: {
    id: CIRCLEKIT_ASSET_CATALOG.id,
    version: CIRCLEKIT_ASSET_CATALOG.version,
  },
  iconRefs,
  ui: [
    { id: "link.navigation", kind: "menu-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.menu", "ui.navigation"], ports: { state: "navigation.destination", action: "navigation.open" } },
    { id: "link.capture", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "capture.status", action: "capture.command" } },
    { id: "link.delivery", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "conversation.status" } },
    { id: "link.reply", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "conversation.status" } },
    { id: "link.playback", kind: "component-entry", artifacts: ALL_ARTIFACTS, requiredCapabilities: ["ui.component-tree"], ports: { state: "playback.status", action: "playback.command" } },
  ],
}, CIRCLEKIT_ASSET_CATALOG);

export interface AgentmuxLinkProductIr extends ProductIr {
  readonly productSpecVersion: string;
  readonly link: {
    readonly routes: typeof linkRoutes;
    readonly menuActions: typeof linkMenuActions;
    readonly nativeComponents: LinkNativeRegistry["components"];
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
      routes: linkRoutes,
      menuActions: linkMenuActions,
      nativeComponents: registry.components,
      nativeServices: registry.services,
    },
  };
}

function requireCatalogSound(): void {
  const artifacts = new Set(baseProduct.artifacts.map(({ id }) => id));
  const routes = new Set(linkRoutes.map(({ id }) => id));
  requireUnique([...artifacts], "artifact id");
  requireUnique([...routes], "route id");
  for (const artifact of baseProduct.artifacts) requireUnique(artifact.serves, `surface in '${artifact.id}'`);
  for (const item of [...linkRoutes, ...linkMenuActions, ...baseProduct.iconRefs]) {
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
  requireExactSet(new Set(baseProduct.artifacts.map(({ id }) => id)), new Set(registry.profiles), "profile/native binding");
  requireExactSet(new Set(baseProduct.iconRefs.map(({ assetRef }) => assetRef)), new Set(registry.icons.map(({ iconId }) => iconId)), "icon/native binding");
  requireUnique(registry.components.map(({ componentId }) => componentId), "native component id");
  requireExactSet(new Set(baseProduct.componentCatalog.map(({ id }) => id)), new Set(registry.components.map(({ componentId }) => componentId)), "component/native binding");
  for (const component of baseProduct.componentCatalog) {
    const native = registry.components.find(({ componentId }) => componentId === component.id);
    requireExactSet(new Set(componentArtifacts(component.id)), new Set(native?.profiles ?? []), `component '${component.id}' profile`);
  }
  const mounts = baseProduct.legos.mounts;
  requireExactSet(new Set(mounts.map(({ id }) => id)), new Set(registry.services.map(({ serviceId }) => serviceId)), "service/native binding");
  for (const service of registry.services) {
    const mounted = mounts.find(({ id }) => id === service.serviceId);
    if (mounted === undefined) throw new Error(`orphan native service '${service.serviceId}'`);
    requireExactSet(new Set(mounted.lego.inputs.map(({ id }) => id)), new Set(service.inputPorts), `service '${service.serviceId}' input`);
    requireExactSet(new Set(mounted.lego.outputs.map(({ id }) => id)), new Set(service.outputPorts), `service '${service.serviceId}' output`);
    requireExactSet(new Set(baseProduct.artifacts.map(({ id }) => id)), new Set(service.profiles), `service '${service.serviceId}' profile`);
  }
}

function componentArtifacts(componentId: string): string[] {
  const icon = baseProduct.iconRefs.find(({ id }) => id === `component.${componentId}`);
  if (icon === undefined) throw new Error(`component '${componentId}' has no portable icon ref`);
  return [...icon.artifacts];
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
