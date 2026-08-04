import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeLinkNativeRegistry } from "../src/native-registry.js";
import { productArtifactConformance } from "@v1d/product-spec";
import { compileAgentmuxLinkProduct } from "../src/product.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rawRegistryJson = await readFile(resolve(root, "native-registry/link.json"), "utf8");
const registry = decodeLinkNativeRegistry(JSON.parse(rawRegistryJson));

test("one Link product drives Phone and Wear with a closed native graph", () => {
  const product = compileAgentmuxLinkProduct(registry, "0.3.25");
  assert.deepEqual(product.artifacts.map(({ id }) => id), ["phone-full-ui", "wear-full-ui"]);
  assert.equal(product.componentFamilies.length, 3);
  assert.equal(product.legos.mounts.length, 10);
  assert.deepEqual(product.legos.wiring, [
    { from: "capture.captured", to: "conversation.turn" },
  ]);
  assert.equal(product.legos.mounts.find(({ id }) => id === "conversation")?.lego.runtime.durability, "durable");
  assert.equal(product.assetCatalogRef.id, "circlekit");
  assert.deepEqual(product.palette.variants, []);
  assert.ok(product.link.routes.every(({ artifacts }) => artifacts.length > 0));
  // The component↔service join is total: every catalog component resolves to
  // typed ui-entry portRefs or a named framework reason.
  for (const { id } of product.componentCatalog) {
    const binding = product.link.componentBindings[id];
    assert.ok(binding, `component '${id}' has no wiring binding`);
    if (binding.kind === "ui") {
      for (const entry of binding.entries) {
        assert.ok(product.ui.some((candidate) => candidate.id === entry));
      }
    }
  }
});

test("missing native component fails before emission", () => {
  assert.throws(
    () => compileAgentmuxLinkProduct({ ...registry, components: registry.components.slice(1) }, "0.3.25"),
    /component\/native binding missing/,
  );
});

// Criterion 4 of SVW-0112: Link, Showcase and Skyvw verify the SAME contract
// through the same helper, so drift between a product and its native bindings
// cannot hide behind a per-product test. Link is the second of the three.
//
// Link declares every manifest section, so unlike Showcase there is nothing
// unasserted here — an empty list is the strongest result this helper can give.
test("Link conforms to its native bindings through the shared helper", () => {
  const product = compileAgentmuxLinkProduct(registry, "0.3.31");
  const raw = JSON.parse(rawRegistryJson);

  assert.deepEqual(productArtifactConformance(product, raw), []);
});
