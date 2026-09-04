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
            { instance: "navigation.page-host", region: "host" },
            { instance: "target.picker", region: "content" },
            { instance: "capture.talk", region: "content" },
            { instance: "conversation.latest", region: "content" },
            { instance: "navigation.settings-entry", region: "chrome" },
          ] },
          { surface: "compact", mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "target.picker", region: "content" },
            { instance: "conversation.latest", region: "content" },
            { instance: "conversation.composer", region: "footer" },
            { instance: "capture.talk", region: "footer" },
            { instance: "navigation.settings-entry", region: "chrome" },
          ] },
          { surface: "wide", mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "target.picker", region: "rail" },
            { instance: "conversation.latest", region: "content" },
            { instance: "conversation.composer", region: "footer" },
            { instance: "capture.talk", region: "footer" },
            { instance: "navigation.settings-entry", region: "chrome" },
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
            { instance: "navigation.page-host", region: "host" },
            { instance: "session.connection", region: "content" },
            { instance: "updates.panel", region: "content" },
            { instance: "navigation.dev-host-entry", region: "content", requirement: optional },
            { instance: "recovery.status", region: "content", requirement: optional },
          ] },
          { surface: "compact", mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "playback.controls", region: "content", requirement: optional },
            { instance: "session.connection", region: "content" },
            { instance: "session.public-link", region: "content" },
            { instance: "preferences.toggles", region: "content" },
            { instance: "history.local", region: "content" },
            { instance: "updates.panel", region: "content" },
            { instance: "navigation.dev-host-entry", region: "content" },
            { instance: "recovery.status", region: "content", requirement: optional },
          ] },
          { surface: "wide", mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "playback.controls", region: "rail", requirement: optional },
            { instance: "session.connection", region: "content" },
            { instance: "session.public-link", region: "content" },
            { instance: "preferences.toggles", region: "content" },
            { instance: "history.local", region: "content" },
            { instance: "updates.panel", region: "content" },
            { instance: "navigation.dev-host-entry", region: "content" },
            { instance: "recovery.status", region: "content", requirement: optional },
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
          mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "dev.preview", region: "content" },
          ],
        })),
      },
    },
  ],
);
