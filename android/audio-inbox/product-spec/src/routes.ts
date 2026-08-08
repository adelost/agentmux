/**
 * Screen identity: the header title and icon each route shows.
 *
 * This is product judgment, not renderer policy, so it is declared here and
 * emitted. It used to live as `headerTitle`/`headerIconId` properties on a
 * Kotlin enum, which is exactly the hand-written parallel truth SVW-0125
 * removes: two places could disagree about what a screen is called and
 * nothing would fail.
 *
 * The titles and icon assets are migrated verbatim from the pre-graph
 * `catalog.ts`; the cutover deleted that file and took them with it.
 *
 * `artifacts` is the closed set of hosts that may show the route, mirroring
 * the artifact profiles in product.ts. A route no host serves is a
 * declaration error, not a screen nobody happens to open.
 */
export const linkRoutes = [
  { id: "home", title: "AGENTMUX LINK", iconAssetRef: "link", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "settings", title: "LINK SETTINGS", iconAssetRef: "gear", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "dev-host", title: "DEV HOST", iconAssetRef: "phone", artifacts: ["phone-full-ui"] },
] as const;

export type LinkRouteId = (typeof linkRoutes)[number]["id"];

/** Icon refs the product owns for its routes, in the same shape as component icons. */
export const linkRouteIconRefs = linkRoutes.map((route) => ({
  id: `route.${route.id}`,
  assetRef: route.iconAssetRef,
  artifacts: route.artifacts,
}));
