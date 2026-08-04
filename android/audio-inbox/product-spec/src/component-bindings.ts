/**
 * The component↔service join the upstream schema cannot express: every mounted
 * component names the typed UI entries whose portRefs it renders through, or an
 * explicit self-contained framework reference. Total in both directions;
 * requireComponentWiring() in product.ts fails compilation before emission.
 */
export type LinkComponentBinding =
  | { readonly kind: "ui"; readonly entries: readonly [string, ...string[]] }
  | { readonly kind: "framework"; readonly reason: string };

export const linkComponentBindings: Readonly<Record<string, LinkComponentBinding>> = {
  target: { kind: "ui", entries: ["link.target"] },
  latest: { kind: "ui", entries: ["link.delivery", "link.reply"] },
  composer: { kind: "ui", entries: ["link.composer"] },
  talk: { kind: "ui", entries: ["link.capture"] },
  "active-playback": { kind: "ui", entries: ["link.playback"] },
  connection: { kind: "ui", entries: ["link.session"] },
  "public-link": { kind: "ui", entries: ["link.session"] },
  preferences: { kind: "ui", entries: ["link.preferences"] },
  "local-history": { kind: "ui", entries: ["link.history"] },
  updates: { kind: "ui", entries: ["link.updates"] },
  "dev-host": { kind: "ui", entries: ["link.navigation"] },
  recovery: { kind: "ui", entries: ["link.recovery"] },
  "dev-preview": {
    kind: "framework",
    reason: "self-contained CircleKit host preview; renders outside the product service graph",
  },
} as const;
