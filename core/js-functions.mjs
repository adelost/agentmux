/**
 * WHAT: Function spans and names for JavaScript and TypeScript sources, from a real parser.
 * WHY: lizard mis-nests modern JS: `x.match(re)?.[1]` made one function swallow the rest of the file, so the
 * hotspot hook asked for a verdict on a function the commit never touched (claw:1, 1.25.67, core/dream-owner.mjs).
 */
import { parse } from "@babel/parser";

const JS_SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/iu;
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ClassMethod", "ClassPrivateMethod", "ObjectMethod", "TSDeclareMethod",
]);
const SKIPPED_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);

export const isJsSource = (path) => JS_SOURCE.test(path);

function parserPlugins(path) {
  if (/\.(ts|mts|cts)$/iu.test(path)) return ["typescript"];
  if (/\.tsx$/iu.test(path)) return ["typescript", "jsx"];
  return ["jsx"];
}

function keyName(key) {
  if (!key) return null;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateName") return `#${key.id.name}`;
  if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value);
  return null;
}

/** The name a reader calls a function by: its own id, or the variable, property or member it is assigned to. */
function functionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (node.key) return keyName(node.key);
  if (!parent) return null;
  if (parent.type === "VariableDeclarator") return keyName(parent.id);
  if (parent.type === "ObjectProperty" || parent.type === "ClassProperty" || parent.type === "ClassPrivateProperty") return keyName(parent.key);
  if (parent.type === "AssignmentExpression") return keyName(parent.left?.property) || keyName(parent.left);
  if (parent.type === "AssignmentPattern") return keyName(parent.left);
  return null;
}

/** Every function in one JS/TS source, named like lizard rows so hotspot rules treat both the same. */
export function jsFunctions(path, source) {
  const ast = parse(source, {
    sourceType: "unambiguous", errorRecovery: true, allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true, plugins: parserPlugins(path),
  });
  const functions = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (FUNCTION_TYPES.has(node.type) && node.loc) {
      const start = node.loc.start.line;
      const end = node.loc.end.line;
      functions.push({ path, name: functionName(node, parent) || "(anonymous)", start, end, nloc: end - start + 1, ccn: null });
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value === "object") visit(value, node);
    }
  };
  visit(ast.program, null);
  return functions;
}
