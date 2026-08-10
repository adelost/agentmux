import { CIRCLEKIT_ASSET_CATALOG } from "@v1d/circlekit-assets";
import { defineProduct, type ProductIr } from "@v1d/product-spec";
import { linkComponentInstances, linkComponentTypes } from "./components.js";
import { linkFiniteValues } from "./finite-values.js";
import { linkProductIconRefs } from "./icons.js";
import { linkConfigs, linkNodes } from "./nodes.js";
import { linkScreenComponentFamilies } from "./screens.js";
import { linkStateAuthorityDefinitions } from "./state-authorities.js";
import { linkNodeTypes } from "./node-types.js";

const linkPalette = { variants: [] } as const;

/**
 * The one portable Link product graph: mandatory typed node and component
 * ports, instances and mounts as the only source. There is no ui list, no
 * parallel manifest and no runtime JSON here — native bindings are attested
 * against the compiled IR by the generic conformance engine.
 */
const linkProductCore = defineProduct({
  id: "agentmux-link",
  rendererBindings: [
    { id: "android-phone-compose", capabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
    { id: "android-wear-compose", capabilities: ["ui.menu", "ui.navigation", "ui.component-tree"] },
  ],
  artifacts: [
    {
      id: "phone-full-ui",
      rendererRefs: ["android-phone-compose"],
      requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"],
      entryScreen: "home",
      screenRefs: ["home", "settings", "dev-host"],
      serves: ["round", "compact", "wide"],
    },
    {
      id: "wear-full-ui",
      rendererRefs: ["android-wear-compose"],
      requiredCapabilities: ["ui.menu", "ui.navigation", "ui.component-tree"],
      entryScreen: "home",
      screenRefs: ["home", "settings"],
      serves: ["round"],
    },
  ],
  nodeTypes: linkNodeTypes,
  nodes: linkNodes,
  configs: linkConfigs,
  finiteValues: linkFiniteValues,
  stateAuthorities: linkStateAuthorityDefinitions.map(({ authority }) => authority),
  componentTypes: linkComponentTypes,
  components: linkComponentInstances,
  componentFamilies: linkScreenComponentFamilies,
  palette: linkPalette,
  assetCatalogRef: {
    id: CIRCLEKIT_ASSET_CATALOG.id,
    version: CIRCLEKIT_ASSET_CATALOG.version,
  },
  iconRefs: linkProductIconRefs,
}, CIRCLEKIT_ASSET_CATALOG);

export interface AgentmuxLinkProductIr extends ProductIr {
  readonly productSpecVersion: string;
}

export function compileAgentmuxLinkProduct(productSpecVersion: string): AgentmuxLinkProductIr {
  if (productSpecVersion.trim() === "") throw new Error("ProductSpec package version is blank");
  return { ...linkProductCore, productSpecVersion };
}
