/**
 * Presentation metadata for the closed pages ProductSpec derives from the
 * component-family screens. Page identity, artifact scope and navigation
 * semantics do not live here; the emitter requires these keys to cover the
 * compiled navigation pages exactly.
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
 */
export const linkPagePresentations = [
  { id: "home", title: "LINK", iconAssetRef: "link" },
  { id: "settings", title: "SETTINGS", iconAssetRef: "gear" },
  { id: "dev-host", title: "DISPLAY PREVIEW", iconAssetRef: "phone" },
] as const;

/**
 * Shared visual copy for the settings RouteIntent affordance. Its source port,
 * service target and push effect come from product.navigation.actionGroups;
 * this object deliberately cannot name a destination.
 */
export const linkSettingsActionPresentation = {
  id: "open-settings",
  rowKey: "settings",
  title: "SETTINGS",
  detail: "Connection, sound & updates",
  a11y: "Open Link settings",
  iconAssetRef: "gear",
} as const;
