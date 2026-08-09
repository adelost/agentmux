import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeNativeBindingManifest,
  productArtifactConformance,
  productArtifactHostCoverage,
} from "@v1d/product-spec";
import { compileAgentmuxLinkProduct } from "../src/product.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const product = compileAgentmuxLinkProduct("0.0.0-test");
const manifest = decodeNativeBindingManifest(
  JSON.parse(await readFile(resolve(packageRoot, "native-registry/link.json"), "utf8")),
);

test("the mandatory graph has no parallel list and one binding per data input", () => {
  assert.equal("legos" in product, false, "old lego graph must not survive");
  assert.equal("ui" in product, false, "old ui entry list must not survive");
  assert.equal("componentCatalog" in product, false, "port-less catalog must not survive");
  assert.equal(product.nodes.length, 20);
  assert.equal(product.nodes.filter(({ nodeTypeRef }) =>
    product.nodeTypes.find(({ id }) => id === nodeTypeRef)?.kind === "service").length, 10);
  assert.equal(product.nodes.filter(({ nodeTypeRef }) =>
    product.nodeTypes.find(({ id }) => id === nodeTypeRef)?.kind === "present").length, 10);
  assert.equal(product.components.length, 14);
  assert.equal(product.componentTypes.length, 13);
  for (const node of product.nodes) {
    const kind = product.nodeTypes.find(({ id }) => id === node.nodeTypeRef)?.kind;
    if (kind === "service") assert.equal(node.activation?.kind, "lifetime", `${node.id} must stay process-lived`);
    if (kind === "present") assert.equal(node.activation, undefined, `${node.id} must not own lifecycle`);
  }
  assert.deepEqual(product.portRegistry.demandEdges, []);
  const inputs = product.portRegistry.nodePorts.filter(({ direction }) => direction === "input");
  const bound = new Set(product.portRegistry.bindings.map(({ to }) => to));
  for (const input of inputs) {
    assert.ok(bound.has(input.ref), `node data input ${input.ref} has no upstream`);
  }
  const componentInputs = product.portRegistry.componentPorts.filter(({ direction }) => direction === "input");
  for (const input of componentInputs) {
    assert.ok(bound.has(input.ref), `component input ${input.ref} has no upstream`);
  }
});

test("capture, delivery, reply and playback are typed graph edges", () => {
  const edges = product.portRegistry.bindings.map(({ from, to }) => `${from}->${to}`);
  assert.ok(edges.includes("capture.service.captured->conversation.service.turn"));
  assert.ok(edges.includes("talk.command->capture.service.command"));
  assert.ok(edges.includes("composer.compose->conversation.service.compose"));
  assert.ok(edges.includes("active-playback.command->playback.service.command"));
  assert.ok(edges.includes("latest.model->conversation.service.status") === false,
    "bindings point from outputs to inputs, never the reverse");
  assert.ok(edges.includes("conversation.service.status->conversation.presentation.source"));
  assert.ok(edges.includes("conversation.presentation.model->latest.model"));
  assert.ok(edges.includes("conversation.presentation.model->composer.model"));
  assert.ok(edges.includes("playback.service.status->playback.presentation.source"));
  assert.ok(edges.includes("playback.presentation.model->active-playback.model"));
  assert.equal(product.portRegistry.bindings.some(({ kind, from }) =>
    kind === "component-input" && from.includes(".service.")), false,
  "an effect-owning service must never feed a component directly");
});

test("pages and artifacts cover exactly the declared screens", () => {
  assert.deepEqual(product.componentFamilies.map(({ screen }) => screen), ["home", "settings", "dev-host"]);
  const phone = product.artifacts.find(({ id }) => id === "phone-full-ui");
  const wear = product.artifacts.find(({ id }) => id === "wear-full-ui");
  assert.deepEqual(phone?.screenRefs, ["home", "settings", "dev-host"]);
  assert.deepEqual(wear?.screenRefs, ["home", "settings"]);
  assert.deepEqual(wear?.serves, ["round"]);
});

test("native binding manifest conforms, with node ports native-attested", () => {
  const findings = productArtifactConformance(product, manifest);
  assert.deepEqual(findings, [{
    axis: "node-port",
    direction: "unasserted",
    subject: "nodes",
    message: findings[0]?.message ?? "",
  }]);
  assert.equal(findings[0]?.direction, "unasserted");
  assert.deepEqual(productArtifactHostCoverage(product, [manifest]), []);
});

test("conformance engine goes red on manifest drift", () => {
  const withoutComponent = {
    ...manifest,
    components: manifest.components.filter(({ componentId }) => componentId !== "link.talk"),
  };
  const findings = productArtifactConformance(product, withoutComponent);
  assert.ok(findings.some((finding) =>
    finding.axis === "component" && finding.direction === "missing" && finding.subject.startsWith("link.talk@")
  ));
  const withoutIcon = { ...manifest, icons: manifest.icons.filter(({ iconId }) => iconId !== "record") };
  assert.ok(productArtifactConformance(product, withoutIcon).some((finding) =>
    finding.axis === "icon" && finding.direction === "missing" && finding.subject === "record"
  ));
  const bogusFinite = {
    ...manifest,
    finiteValues: [...(manifest.finiteValues ?? []), { id: "link.bogus", values: ["x"] }],
  };
  assert.ok(productArtifactConformance(product, bogusFinite).some((finding) =>
    finding.axis === "finite-value" && finding.direction === "orphan" && finding.subject === "link.bogus"
  ));
  const driftedFinite = {
    ...manifest,
    finiteValues: (manifest.finiteValues ?? []).map((entry) =>
      entry.id === "link.capture-phase" ? { ...entry, values: [...entry.values, "exploded"] } : entry),
  };
  assert.ok(productArtifactConformance(product, driftedFinite).some((finding) =>
    finding.axis === "finite-value" && finding.direction === "mismatch" && finding.subject === "link.capture-phase"
  ));
});

test("the declared product carries no platform symbols or runtime JSON", () => {
  const serialized = JSON.stringify(product);
  for (const banned of ["androidx", "Composable", "ImageVector", "RingIcons.", "kotlin"]) {
    assert.equal(serialized.includes(banned), false, `platform symbol '${banned}' leaked into the product IR`);
  }
});
