const ALL_ARTIFACTS = ["phone-full-ui", "wear-full-ui"] as const;

/**
 * One portable icon per visual component instance. Page icons are joined to
 * compiled artifact screenRefs in product.ts, beside the authoritative
 * artifact declarations.
 */
export const linkComponentIconRefs = [
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
  { id: "component.settings-action", assetRef: "gear", artifacts: ALL_ARTIFACTS },
  { id: "component.dev-host", assetRef: "phone", artifacts: ["phone-full-ui"] },
  { id: "component.recovery", assetRef: "warning", artifacts: ALL_ARTIFACTS },
  { id: "component.dev-preview", assetRef: "phone", artifacts: ["phone-full-ui"] },
] as const;
