import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";

// The repository is public. Real logins come from the local account profiles
// (`amux quota` shows them); docs, skills and tests use example.test addresses.
const ROOT = join(import.meta.dirname, "..");
const PERSONAL_ADDRESS = /[\w.%+-]+@(?:gmail|googlemail|hotmail|outlook|live|icloud|me|yahoo|proton(?:mail)?)\\?\.[a-z]{2,}/giu;

function personalAddressesInTrackedFiles() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  return files.flatMap((file) => {
    let text;
    try { text = readFileSync(join(ROOT, file), "utf8"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "EISDIR") return []; throw error; }
    return [...text.matchAll(PERSONAL_ADDRESS)].map((match) => `${file}: ${match[0]}`);
  });
}

feature("public repository privacy", () => {
  component("no tracked file holds an address at a personal mail provider", {
    when: ["scanning every tracked file", () => personalAddressesInTrackedFiles()],
    then: ["none is found", (found) => expect(found).toEqual([])],
  });
});
