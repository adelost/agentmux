import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeLinkNativeRegistry } from "../src/native-registry.js";
import { compileAgentmuxLinkProduct } from "../src/product.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registry = decodeLinkNativeRegistry(
  JSON.parse(await readFile(resolve(root, "native-registry/link.json"), "utf8")),
);

test("one Link product drives Phone and Wear with a closed native graph", () => {
  const product = compileAgentmuxLinkProduct(registry, "0.3.25");
  assert.deepEqual(product.artifacts.map(({ id }) => id), ["phone-full-ui", "wear-full-ui"]);
  assert.equal(product.componentFamilies.length, 3);
  assert.equal(product.legos.mounts.length, 4);
  assert.deepEqual(product.legos.wiring, [
    { from: "capture.captured", to: "conversation.turn" },
  ]);
  assert.equal(product.legos.mounts.find(({ id }) => id === "conversation")?.lego.runtime.durability, "durable");
  assert.equal(product.assetCatalogRef.id, "circlekit");
  assert.deepEqual(product.palette.variants, []);
  assert.ok(product.link.routes.every(({ artifacts }) => artifacts.length > 0));
});

test("missing native component fails before emission", () => {
  assert.throws(
    () => compileAgentmuxLinkProduct({ ...registry, components: registry.components.slice(1) }, "0.3.25"),
    /component\/native binding missing/,
  );
});
