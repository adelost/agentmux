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
  type ProductEmitterPlugin,
} from "@v1d/product-spec";
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
import { compileAgentmuxLinkProduct } from "./product.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const linkRoot = resolve(packageRoot, "..");
const productSpecPackagePath = resolve(packageRoot, "node_modules/@v1d/product-spec/package.json");
const jsonPath = "product-spec/generated/link-product.json";
const domainsPath = "product-spec/generated/link-product.domains.mmd";
const graphPath = "product-spec/generated/link-product.graph.mmd";
const kotlinRoot = "link-ui/src/main/java/io/agentmux/linkui/product/generated";
const check = process.argv.includes("--check");

const productSpecPackage = JSON.parse(await readFile(productSpecPackagePath, "utf8")) as { version?: unknown };
if (typeof productSpecPackage.version !== "string") throw new Error("Installed @v1d/product-spec has no version");
const product = compileAgentmuxLinkProduct(productSpecPackage.version);
const manifest = buildOutputManifest(
  product,
  [
    productJsonEmitter(jsonPath),
    linkNativeEmitter(kotlinRoot),
    linkContractTypesEmitter(),
    domainGraphEmitter({ domains: domainsPath, full: graphPath, productJsonPath: jsonPath }, linkCapabilityTable),
  ],
  [jsonPath, domainsPath, graphPath, kotlinRoot],
);

if (check) {
  const stale = await checkOutputManifest(linkRoot, manifest);
  if (stale.length > 0) throw new Error(`Generated Link product is stale:\n${stale.join("\n")}`);
} else {
  await writeOutputManifest(linkRoot, manifest);
}
console.log(logOutputManifest(manifest));

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
