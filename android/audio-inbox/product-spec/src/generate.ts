import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutputManifest,
  checkOutputManifest,
  logOutputManifest,
  productJsonEmitter,
  writeOutputManifest,
} from "@v1d/product-spec/node";
import type { ProductEmitterPlugin } from "@v1d/product-spec";
import { domainGraphEmitter, emitContractTypesKotlin } from "@v1d/product-emit/core";
import { linkCapabilityTable } from "./capabilities.js";
import {
  capturedTurnContract,
  composeTurnContract,
  historyClearContract,
  historyStatusContract,
  preferencesStatusContract,
  targetSelectContract,
} from "./contracts.js";
import { linkNativeEmitter } from "./emit-kotlin.js";
import { linkControls, linkGesturesWithoutATiming } from "./interactions.js";
import { compileAgentmuxLinkProduct } from "./product.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const linkRoot = resolve(packageRoot, "..");
const productSpecPackagePath = resolve(packageRoot, "node_modules/@v1d/product-spec/package.json");
const jsonPath = "product-spec/generated/link-product.json";
const domainsPath = "product-spec/generated/link-product.domains.mmd";
const graphPath = "product-spec/generated/link-product.graph.mmd";
const kotlinRoot = "link-ui/src/main/java/io/agentmux/linkui/product/generated";
const kotlinDebugRoot = "link-ui/src/debug/java/io/agentmux/linkui/product/generated";
const kotlinReleaseRoot = "link-ui/src/release/java/io/agentmux/linkui/product/generated";
const check = process.argv.includes("--check");

const productSpecPackage = JSON.parse(await readFile(productSpecPackagePath, "utf8")) as { version?: unknown };
if (typeof productSpecPackage.version !== "string") throw new Error("Installed @v1d/product-spec has no version");
const product = compileAgentmuxLinkProduct(productSpecPackage.version);
const manifest = buildOutputManifest(
  product,
  [
    productJsonEmitter(jsonPath),
    linkStudioIdentityEmitter(productSpecPackage.version),
    linkNativeEmitter(kotlinRoot),
    linkContractTypesEmitter(),
    linkControlTimingEmitter(),
    domainGraphEmitter({ domains: domainsPath, full: graphPath, productJsonPath: jsonPath }, linkCapabilityTable),
  ],
  [jsonPath, domainsPath, graphPath, kotlinRoot, kotlinDebugRoot, kotlinReleaseRoot],
);

if (check) {
  const stale = await checkOutputManifest(linkRoot, manifest);
  if (stale.length > 0) throw new Error(`Generated Link product is stale:\n${stale.join("\n")}`);
} else {
  await writeOutputManifest(linkRoot, manifest);
}
console.log(logOutputManifest(manifest));

/** Correlate the native debug hello to the exact emitted product bytes, not a copied model hash. */
function linkStudioIdentityEmitter(productSpecVersion: string): ProductEmitterPlugin {
  return {
    id: "link-studio-identity",
    emit(product) {
      const productBytes = productJsonEmitter(jsonPath).emit(product)[0]!.content;
      const artifactSha256 = createHash("sha256").update(productBytes).digest("hex");
      const events = product.portRegistry.bindings.length > 0 ? ["port"] : [];
      return [{
        id: "link-studio-identity",
        path: `${kotlinDebugRoot}/GeneratedLinkStudioIdentity.kt`,
        mediaType: "text/x-kotlin",
        content: [
          "// Generated from the installed ProductSpec and exact Link product artifact. Debug only.",
          "package io.agentmux.linkui.product.generated", "",
          "internal object GeneratedLinkStudioIdentity {",
          `    const val productId = ${JSON.stringify(product.id)}`,
          `    const val productSpecVersion = ${JSON.stringify(productSpecVersion)}`,
          `    const val artifactSha256 = ${JSON.stringify(artifactSha256)}`,
          `    val events = listOf(${events.map((event) => JSON.stringify(event)).join(", ")})`,
          "}", "",
        ].join("\n"),
      }];
    },
  };
}

/**
 * The contracts native code holds as plain values, as generated data classes: a renamed or retyped declared field
 * fails the Kotlin build until the native code follows (Skyvw row 168's pattern, row 174). Only contracts whose fields
 * are all primitives; the rest are carried by the state presentations and the port catalog.
 */
function linkContractTypesEmitter(): ProductEmitterPlugin {
  const contracts = [
    capturedTurnContract,
    composeTurnContract,
    targetSelectContract,
    historyStatusContract,
    historyClearContract,
    preferencesStatusContract,
  ];
  return {
    id: "link-contract-types",
    emit: () => [{
      id: "contract-types",
      path: `${kotlinRoot}/GeneratedLinkContracts.kt`,
      mediaType: "text/x-kotlin",
      content: emitContractTypesKotlin(contracts, {
        packageName: "io.agentmux.linkui.product.generated",
        symbolPrefix: "Link",
        sourceFile: "product-spec/src/contracts.ts",
        sourceSha: createHash("sha256").update(JSON.stringify(contracts)).digest("hex"),
      }),
    }],
  };
}

/**
 * Which kind of button each Link control is, as named Kotlin constants.
 *
 * Row 225. Named rather than a lookup by string, so a control whose declaration is missing fails the
 * Kotlin build instead of quietly falling back to a default: the whole defect was a control taking
 * its timing from something other than its own declaration.
 */
function linkControlTimingEmitter(): ProductEmitterPlugin {
  const constantName = (id: string) => id.replace(/[.-]/g, "_").toUpperCase();
  const timingConstant = (timing: string) => (timing === "immediate" ? "IMMEDIATE" : "DELIBERATE");
  const sha = createHash("sha256")
    .update(JSON.stringify([linkControls, linkGesturesWithoutATiming]))
    .digest("hex");
  const body = linkControls
    .map(({ id, title, timing, why }) => [
      `    /** ${title}. ${why} */`,
      `    val ${constantName(id)}: CircleActionTiming = CircleActionTiming.${timingConstant(timing)}`,
    ].join("\n"))
    .join("\n\n");
  const neither = linkGesturesWithoutATiming
    .map(({ title, why }) => ` * - ${title}: ${why}`)
    .join("\n");
  const content = `// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM product-spec/src/interactions.ts
// Product declaration SHA-256: ${sha}
package ${"io.agentmux.linkui.product.generated"}

import com.adelost.designkit.ui.CircleActionTiming

/**
 * Which kind of button each Link control is: touch or hold, and nothing between them.
 *
 * The two words and the rule that picks between them belong to the shared ProductSpec vocabulary.
 * A control reads its own constant here, so nothing else can decide for it.
 *
 * GESTURES THAT DECLARE NO TIMING, because their duration is the content rather than a confirmation:
${neither}
 */
object GeneratedLinkControlTiming {
${body}
}
`;
  return {
    id: "link-control-timing",
    emit: () => [{
      id: "control-timing",
      path: `${kotlinRoot}/GeneratedLinkControlTiming.kt`,
      mediaType: "text/x-kotlin",
      content,
    }],
  };
}
