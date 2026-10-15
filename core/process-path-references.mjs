import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** WHAT: Reads cwd, descriptors and mappings for every UID. WHY: Prevents unreadable processes from being mistaken for idle paths. */
export function processPathReferences(targets) {
  try {
    const script = fileURLToPath(new URL("../bin/process-path-references.py", import.meta.url));
    const privileged = process.getuid?.() !== 0;
    const command = privileged ? "sudo" : "/usr/bin/python3";
    const args = privileged ? ["-n", "/usr/bin/python3", script] : [script];
    return JSON.parse(execFileSync(command, args, {
      input: JSON.stringify(targets), encoding: "utf8", timeout: 30000,
      maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    return { holders: {}, errors: [{ error: `process references unreadable: ${error.message}` }] };
  }
}
