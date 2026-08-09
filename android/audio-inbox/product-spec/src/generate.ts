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
import { linkNativeEmitter } from "./emit-kotlin.js";
import { compileAgentmuxLinkProduct } from "./product.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const linkRoot = resolve(packageRoot, "..");
const productSpecPackagePath = resolve(packageRoot, "node_modules/@v1d/product-spec/package.json");
const jsonPath = "product-spec/generated/link-product.json";
const kotlinRoot = "link-ui/src/main/java/io/agentmux/linkui/product/generated";
const check = process.argv.includes("--check");

const productSpecPackage = JSON.parse(await readFile(productSpecPackagePath, "utf8")) as { version?: unknown };
if (typeof productSpecPackage.version !== "string") throw new Error("Installed @v1d/product-spec has no version");
const product = compileAgentmuxLinkProduct(productSpecPackage.version);
const manifest = buildOutputManifest(
  product,
  [productJsonEmitter(jsonPath), linkNativeEmitter(kotlinRoot)],
  [jsonPath, kotlinRoot],
);

if (check) {
  const stale = await checkOutputManifest(linkRoot, manifest);
  if (stale.length > 0) throw new Error(`Generated Link product is stale:\n${stale.join("\n")}`);
} else {
  await writeOutputManifest(linkRoot, manifest);
}
console.log(logOutputManifest(manifest));
