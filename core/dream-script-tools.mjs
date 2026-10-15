import { parse } from "@babel/parser";

const keyName = node => node?.name ?? node?.value;

function staticValue(node, bindings) {
  if (!node) return undefined;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "Identifier") return bindings.get(node.name);
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticValue(node.left, bindings), right = staticValue(node.right, bindings);
    return typeof left === "string" && typeof right === "string" ? left + right : undefined;
  }
  if (node.type === "ObjectExpression") return Object.fromEntries(node.properties.filter(p => p.type === "ObjectProperty")
    .map(p => [keyName(p.key), staticValue(p.value, bindings)]));
  return undefined;
}

/** WHAT: Reads literal tool arguments inside Codex orchestration scripts. WHY: Separates quoted program text from commands that need the memory-write audit. */
export function dreamScriptTools(source) {
  let ast;
  try { ast = parse(source, { sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); }
  catch { throw new Error("dream-curator-script-unverifiable"); }
  const bindings = new Map(), calls = [];
  const visit = node => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") bindings.set(node.id.name, staticValue(node.init, bindings));
    if (node.type === "CallExpression") {
      const name = keyName(node.callee?.property ?? node.callee);
      if (["exec_command", "apply_patch"].includes(name)) {
        const input = staticValue(node.arguments[0], bindings);
        if (name === "exec_command" ? typeof input?.cmd !== "string" : typeof input !== "string") {
          throw new Error("dream-curator-script-tool-unverifiable");
        }
        calls.push({ tool: name, input });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast.program);
  return calls;
}

/** WHAT: Returns shell operators with literals blanked at unchanged offsets. WHY: Prevents a quoted awk comparison from counting as an output redirect. */
export function shellOperators(source) {
  let quote = null, escaped = false;
  return source.split("").map(char => {
    if (escaped) { escaped = false; return " "; }
    if (char === "\\" && quote !== "'") { escaped = true; return " "; }
    if (quote) { if (char === quote) quote = null; return char === "\n" ? "\n" : " "; }
    if (["'", '"', "`"].includes(char)) { quote = char; return " "; }
    return char;
  }).join("");
}
