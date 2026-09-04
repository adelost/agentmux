import { adapterFields } from "@v1d/product-spec/foundation";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NATIVE_BINDING_MANIFEST_SCHEMA_VERSION,
  PRODUCT_SPEC_SCHEMA_VERSION,
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
  assert.equal(product.schemaVersion, PRODUCT_SPEC_SCHEMA_VERSION);
  assert.equal(manifest.schemaVersion, NATIVE_BINDING_MANIFEST_SCHEMA_VERSION);
  assert.equal("legos" in product, false, "old lego graph must not survive");
  assert.equal("ui" in product, false, "old ui entry list must not survive");
  assert.equal("componentCatalog" in product, false, "port-less catalog must not survive");
  assert.equal(product.nodes.length, 27);
  assert.equal(product.nodes.filter(({ nodeTypeRef }) =>
    product.nodeTypes.find(({ id }) => id === nodeTypeRef)?.kind === "service").length, 10);
  assert.equal(product.nodes.filter(({ nodeTypeRef }) =>
    product.nodeTypes.find(({ id }) => id === nodeTypeRef)?.kind === "present").length, 17);
  assert.equal(product.components.length, 15);
  assert.equal(product.componentTypes.length, 15);
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
  assert.deepEqual(product.portRegistry.bindings
    .filter(({ kind, from }) => kind === "component-input" && from.includes(".service."))
    .map(({ from, to }) => `${from}->${to}`), [
    "navigation.service.activePage->page-host.activePage",
  ], "only the typed active PageId may cross service-to-page-host directly");
});

test("pages and artifacts cover exactly the declared screens", () => {
  assert.deepEqual(product.componentFamilies.map(({ screen }) => screen), ["home", "settings", "dev-host"]);
  const phone = product.artifacts.find(({ id }) => id === "phone-full-ui");
  const wear = product.artifacts.find(({ id }) => id === "wear-full-ui");
  assert.deepEqual(phone?.screenRefs, ["home", "settings", "dev-host"]);
  assert.deepEqual(wear?.screenRefs, ["home", "settings"]);
  assert.deepEqual(wear?.serves, ["round"]);
  assert.equal(product.navigation.pageValuesRef, "link.navigation.page");
  assert.equal(product.navigation.activePagePortRef, "navigation.service.activePage");
  assert.equal(product.navigation.pageHostPortRef, "page-host.activePage");
  assert.deepEqual(product.navigation.routeIntentContract.fields.map(({ name }) => name), ["target"]);
  assert.deepEqual(product.navigation.artifacts.map(({ artifactRef, entryPageRef, pages }) => ({
    artifactRef,
    entryPageRef,
    pages: pages.map(({ pageRef, restore, back }) => `${pageRef}:${restore}:${back}`),
  })), [
    {
      artifactRef: "phone-full-ui", entryPageRef: "home",
      pages: ["home:root:system", "settings:process:previous", "dev-host:process:previous"],
    },
    {
      artifactRef: "wear-full-ui", entryPageRef: "home",
      pages: ["home:root:system", "settings:process:previous"],
    },
  ]);
  assert.deepEqual(product.navigation.actionGroups
    .filter(({ actions }) => actions.some(({ kind }) => kind === "route"))
    .map(({ componentInstanceRef, artifactRefs, actions }) => ({
      componentInstanceRef,
      artifactRefs,
      actions: actions.map(({ sourcePortRef, targetPortRef, effect }) =>
        `${sourcePortRef}->${targetPortRef}:${effect}`),
    })), [
    {
      componentInstanceRef: "dev-host",
      artifactRefs: ["phone-full-ui"],
      actions: ["dev-host.open->navigation.service.openDevHost:push"],
    },
    {
      componentInstanceRef: "settings-action",
      artifactRefs: ["phone-full-ui", "wear-full-ui"],
      actions: ["settings-action.open->navigation.service.openSettings:push"],
    },
  ]);
});

test("native binding manifest conforms, with node ports native-attested", () => {
  assert.deepEqual(productArtifactConformance(product, manifest), []);
  assert.deepEqual(productArtifactHostCoverage(product, [manifest]), []);
});

test("every compiler-exposed closed state lineage has one executable authority", () => {
  assert.deepEqual(product.stateAuthorities.map(({ source }) =>
    `${source.portRef}#${source.stateField}`), [
    "capture.service.status#phase",
    "conversation.service.status#deliveryPhase",
    "conversation.service.status#replyPhase",
    "playback.service.status#phase",
    "target.service.directory#kind",
    "session.service.status#connection",
    "updates.service.status#phase",
    "recovery.service.status#phase",
  ]);
  for (const authority of product.stateAuthorities) {
    assert.ok(authority.presentation.consumers.length > 0, `${authority.id} has no component consumer`);
    assert.ok(product.nodes.some(({ id }) => id === adapterFields(authority.adapter).nodeInstanceRef));
  }
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
  const withoutNodeOutput = {
    ...manifest,
    nodes: manifest.nodes.map((node) => node.nodeId === "capture.service"
      ? { ...node, outputPorts: node.outputPorts.filter((port) => port !== "status") }
      : node),
  };
  assert.ok(productArtifactConformance(product, withoutNodeOutput).some((finding) =>
    finding.axis === "node-port" && finding.direction === "missing" &&
      finding.subject === "capture.service.status"
  ));
  const withoutActivePage = {
    ...manifest,
    navigation: { ...manifest.navigation, activePageBindings: [] },
  };
  assert.ok(productArtifactConformance(product, withoutActivePage).some((finding) =>
    finding.axis === "navigation" && finding.direction === "missing" &&
      finding.subject === "navigation.service.activePage->page-host.activePage"
  ));
  const driftedBack = {
    ...manifest,
    navigation: {
      ...manifest.navigation,
      artifacts: manifest.navigation.artifacts.map((artifact) => artifact.artifactRef === "wear-full-ui"
        ? {
          ...artifact,
          pages: artifact.pages.map((page) => page.pageRef === "settings"
            ? { ...page, back: "consume" as const }
            : page),
        }
        : artifact),
    },
  };
  assert.ok(productArtifactConformance(product, driftedBack).some((finding) =>
    finding.axis === "navigation" && finding.direction === "mismatch" &&
      finding.subject === "wear-full-ui/settings"
  ));
});

test("the declared product carries no platform symbols or runtime JSON", () => {
  const serialized = JSON.stringify(product);
  for (const banned of ["androidx", "Composable", "ImageVector", "RingIcons.", "kotlin"]) {
    assert.equal(serialized.includes(banned), false, `platform symbol '${banned}' leaked into the product IR`);
  }
});
