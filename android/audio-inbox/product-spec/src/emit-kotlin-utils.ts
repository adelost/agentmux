const packageName = "io.agentmux.linkui.product.generated";

export function header(source: string, sha: string): string {
  return `// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ${source}
// Product declarations SHA-256: ${sha}
package ${packageName}
`;
}

export function kotlinEnumToken(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
}
