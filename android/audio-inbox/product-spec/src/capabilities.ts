import { capabilityRows, effectRows, type CapabilityTable } from "@v1d/product-emit/core";

/**
 * Link's host vocabulary: what a node may ask its host for and what it may do
 * to the world, as one closed table. Every `contextInputs` and `effects`
 * string a node type spells must be a row here, and every row must be spelled
 * by some node; the law and the domain graph that draws it live in
 * @v1d/product-emit/core.
 *
 * No STATE_FEEDBACK rows: every Link component reads its state through a
 * port, so the domain graph is the whole picture.
 */
export const linkCapabilityTable: CapabilityTable = {
  sourceFile: "product-spec/src/capabilities.ts",
  capabilities: [
    ...capabilityRows("PERMISSION", ["microphone.permission"]),
    ...capabilityRows("NETWORK", ["network.connectivity"]),
    ...capabilityRows("PLATFORM", ["audio.focus", "transport.route-policy"]),
    ...capabilityRows("STORAGE", ["keystore.session", "storage.preferences", "storage.state-repository"]),
  ],
  effects: [
    ...effectRows("IO", [
      "apk.install",
      "audio.capture",
      "audio.playback",
      "network.fetch",
      "retry.schedule",
      "storage.read",
      "storage.write",
      "transport.auth",
      "transport.poll",
      "transport.receive",
      "transport.send",
    ]),
    ...effectRows("NAVIGATION", ["navigation.route-state"]),
  ],
};
