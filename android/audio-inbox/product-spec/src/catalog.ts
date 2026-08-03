import type { PortableSurfaceClass } from "@v1d/product-spec";

export const LINK_ARTIFACTS = [
  { id: "phone-full-ui", surfaces: ["round", "compact", "wide"] },
  { id: "wear-full-ui", surfaces: ["round"] },
] as const satisfies readonly {
  readonly id: string;
  readonly surfaces: readonly PortableSurfaceClass[];
}[];

export type LinkArtifactId = (typeof LINK_ARTIFACTS)[number]["id"];

export const linkRoutes = [
  { id: "home", title: "AGENTMUX LINK", iconId: "link", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "settings", title: "LINK SETTINGS", iconId: "gear", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "dev-host", title: "DEV HOST", iconId: "phone", artifacts: ["phone-full-ui"] },
] as const;

export const linkMenuActions = [
  {
    id: "open-settings",
    rowId: "settings",
    title: "SETTINGS",
    detail: "CONNECTION & AUDIO",
    a11y: "Open Link settings",
    iconId: "gear",
    destination: "settings",
    artifacts: ["phone-full-ui", "wear-full-ui"],
  },
] as const;

export const linkComponents = [
  { id: "target", rendererId: "status", iconId: "target", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "latest", rendererId: "conversation-feed", iconId: "speaker", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "composer", rendererId: "composer", iconId: "pencil", artifacts: ["phone-full-ui"] },
  { id: "talk", rendererId: "capture", iconId: "record", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "active-playback", rendererId: "active-playback", iconId: "play", artifacts: ["phone-full-ui"] },
  { id: "connection", rendererId: "connection", iconId: "wifi", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "public-link", rendererId: "public-link", iconId: "link", artifacts: ["phone-full-ui"] },
  { id: "preferences", rendererId: "preferences", iconId: "speaker", artifacts: ["phone-full-ui"] },
  { id: "local-history", rendererId: "local-history", iconId: "activity", artifacts: ["phone-full-ui"] },
  { id: "updates", rendererId: "updates", iconId: "download", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "dev-host", rendererId: "dev-host", iconId: "phone", artifacts: ["phone-full-ui"] },
  { id: "recovery", rendererId: "recovery", iconId: "warning", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "dev-preview", rendererId: "dev-preview", iconId: "phone", artifacts: ["phone-full-ui"] },
] as const;

export const linkPalettes = [
  { id: "graphite", artifacts: ["phone-full-ui", "wear-full-ui"] },
] as const;

export const linkIconIds = [...new Set([
  ...linkRoutes.map(({ iconId }) => iconId),
  ...linkMenuActions.map(({ iconId }) => iconId),
  ...linkComponents.map(({ iconId }) => iconId),
])] as const;
