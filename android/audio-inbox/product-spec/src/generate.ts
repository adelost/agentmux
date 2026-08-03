import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutputManifest,
  checkOutputManifest,
  logOutputManifest,
  productJsonEmitter,
  writeOutputManifest,
} from "@v1d/product-spec";
import { linkKotlinEmitter } from "./emit-kotlin.js";
import { decodeLinkNativeRegistry } from "./native-registry.js";
import { compileAgentmuxLinkProduct } from "./product.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const linkRoot = resolve(packageRoot, "..");
const registryPath = resolve(packageRoot, "native-registry/link.json");
const productSpecPackagePath = resolve(packageRoot, "node_modules/@v1d/product-spec/package.json");
const jsonPath = "product-spec/generated/link-product.json";
const kotlinPath = "link-ui/src/main/java/io/agentmux/linkui/product/generated/GeneratedLinkProduct.kt";
const check = process.argv.includes("--check");

const registry = decodeLinkNativeRegistry(JSON.parse(await readFile(registryPath, "utf8")));
const productSpecPackage = JSON.parse(await readFile(productSpecPackagePath, "utf8")) as { version?: unknown };
if (typeof productSpecPackage.version !== "string") throw new Error("Installed @v1d/product-spec has no version");
const product = compileAgentmuxLinkProduct(registry, productSpecPackage.version);
const manifest = buildOutputManifest(
  product,
  [productJsonEmitter(jsonPath), linkKotlinEmitter(kotlinPath)],
  [jsonPath, kotlinPath],
);

if (check) {
  const stale = await checkOutputManifest(linkRoot, manifest);
  if (stale.length > 0) throw new Error(`Generated Link product is stale:\n${stale.join("\n")}`);
} else {
  await writeOutputManifest(linkRoot, manifest);
}
console.log(logOutputManifest(manifest));
