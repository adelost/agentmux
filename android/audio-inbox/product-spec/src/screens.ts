import { defineScreenComponentFamilyRegistry } from "@v1d/product-spec";
import { linkComponentInstances } from "./components.js";

const optional = { kind: "optional", fallback: "omit" } as const;

/**
 * WHAT: Builds every Link screen's ordered component mounts per surface.
 * WHY: Keeps host layout generated from one declaration.
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
            { instance: "preferences.toggles", region: "content" },
            { instance: "wake.toggle", region: "content" },
            { instance: "conversation.latest", region: "content" },
            { instance: "playback.controls", region: "footer", requirement: optional },
            { instance: "conversation.composer", region: "footer" },
            { instance: "capture.talk", region: "footer" },
            { instance: "navigation.settings-entry", region: "chrome" },
          ] },
          { surface: "wide", mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "target.picker", region: "rail" },
            { instance: "preferences.toggles", region: "rail" },
            { instance: "wake.toggle", region: "rail" },
            { instance: "conversation.latest", region: "content" },
            { instance: "playback.controls", region: "footer", requirement: optional },
            { instance: "conversation.composer", region: "footer" },
            { instance: "capture.talk", region: "rail" },
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
            { instance: "wake.status", region: "content" },
            { instance: "navigation.wake-try-entry", region: "content" },
            { instance: "navigation.wake-debug-entry", region: "content" },
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
            { instance: "wake.status", region: "content" },
            { instance: "navigation.wake-try-entry", region: "content" },
            { instance: "navigation.wake-debug-entry", region: "content" },
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
    {
      // A family covers all three surfaces; the page stays phone-only because
      // only the phone artifact lists it, exactly as dev-host does.
      screen: "wake-debug",
      family: {
        id: "link.wake-debug",
        trees: (["round", "compact", "wide"] as const).map((surface) => ({
          surface,
          mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "wake.debug", region: "content" },
          ],
        })),
      },
    },
    {
      // Row 217, phone only for the same reason WAKE DEBUG is.
      screen: "wake-try",
      family: {
        id: "link.wake-try",
        trees: (["round", "compact", "wide"] as const).map((surface) => ({
          surface,
          mounts: [
            { instance: "navigation.page-host", region: "host" },
            { instance: "wake.try", region: "content" },
          ],
        })),
      },
    },
  ],
);
