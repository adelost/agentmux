export const linkRoutes = [
  { id: "home", title: "AGENTMUX LINK", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "settings", title: "LINK SETTINGS", artifacts: ["phone-full-ui", "wear-full-ui"] },
  { id: "dev-host", title: "DEV HOST", artifacts: ["phone-full-ui"] },
] as const;

export const linkMenuActions = [
  {
    id: "open-settings",
    rowId: "settings",
    title: "SETTINGS",
    detail: "CONNECTION & AUDIO",
    a11y: "Open Link settings",
    destination: "settings",
    artifacts: ["phone-full-ui", "wear-full-ui"],
  },
] as const;
