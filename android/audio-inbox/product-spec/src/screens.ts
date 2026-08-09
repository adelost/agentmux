import { defineScreenComponentFamilyRegistry } from "@v1d/product-spec";
import { linkComponentInstances } from "./components.js";

const optional = { kind: "optional", fallback: "omit" } as const;

/**
 * Pages and mounts, migrated one-to-one from the pre-graph component families.
 * The settings entry is chrome on every home surface; dev-host stays a
 * phone-only optional row wherever it was offered before.
 */
export const linkScreenComponentFamilies = defineScreenComponentFamilyRegistry(
  linkComponentInstances,
  [
    {
      screen: "home",
      family: {
        id: "link.home",
        trees: [
          { surface: "round", mounts: [
            { instance: "target", region: "content" },
            { instance: "talk", region: "content" },
            { instance: "latest", region: "content" },
            { instance: "settings-action", region: "chrome" },
          ] },
          { surface: "compact", mounts: [
            { instance: "target", region: "content" },
            { instance: "latest", region: "content" },
            { instance: "composer", region: "footer" },
            { instance: "talk", region: "footer" },
            { instance: "settings-action", region: "chrome" },
          ] },
          { surface: "wide", mounts: [
            { instance: "target", region: "rail" },
            { instance: "latest", region: "content" },
            { instance: "composer", region: "footer" },
            { instance: "talk", region: "footer" },
            { instance: "settings-action", region: "chrome" },
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
            { instance: "connection", region: "content" },
            { instance: "updates", region: "content" },
            { instance: "dev-host", region: "content", requirement: optional },
            { instance: "recovery", region: "content", requirement: optional },
          ] },
          { surface: "compact", mounts: [
            { instance: "active-playback", region: "content", requirement: optional },
            { instance: "connection", region: "content" },
            { instance: "public-link", region: "content" },
            { instance: "preferences", region: "content" },
            { instance: "local-history", region: "content" },
            { instance: "updates", region: "content" },
            { instance: "dev-host", region: "content" },
            { instance: "recovery", region: "content", requirement: optional },
          ] },
          { surface: "wide", mounts: [
            { instance: "active-playback", region: "rail", requirement: optional },
            { instance: "connection", region: "content" },
            { instance: "public-link", region: "content" },
            { instance: "preferences", region: "content" },
            { instance: "local-history", region: "content" },
            { instance: "updates", region: "content" },
            { instance: "dev-host", region: "content" },
            { instance: "recovery", region: "content", requirement: optional },
          ] },
        ],
      },
    },
    {
      screen: "dev-host",
      family: {
        id: "link.dev-host",
        trees: (["round", "compact", "wide"] as const).map((surface) => ({
          surface,
          mounts: [{ instance: "dev-preview", region: "content" }],
        })),
      },
    },
  ],
);
