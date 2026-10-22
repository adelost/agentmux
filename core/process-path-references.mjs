import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** WHAT: Reads cwd, descriptors and mappings for every UID. WHY: Prevents unreadable processes from being mistaken for idle paths. */
export function processPathReferences(targets) {
  return readReferences(targets);
}

/** WHAT: Reads source-root bindings across receipt owners. WHY: Prevents filesystem permissions from leaving unknown references unchecked. */
export function receiptPathReferences(targets,roots,now) {
  return readReferences({targets,roots,now},"receipts");
}

/** WHAT: Dispatches a read-only privileged scanner. WHY: Separates inspection privileges from unprivileged removal. */
function readReferences(request,mode) {
  try {
    const script = fileURLToPath(new URL("../bin/process-path-references.py", import.meta.url));
    const privileged = process.getuid?.() !== 0;
    const command = privileged ? "sudo" : "/usr/bin/python3";
    const args = privileged ? ["-n", "/usr/bin/python3", script] : [script];
    if(mode) args.push(mode);
    return JSON.parse(execFileSync(command, args, {
      // Receipts walk every checkout a cleanup may clear; nightly runs have no deadline of their own.
      input: JSON.stringify(request), encoding: "utf8", timeout: mode ? 900000 : 30000,
      maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    return { holders: {}, protectedPaths:[],errors: [{ error: `safety references unreadable: ${error.message}` }] };
  }
}
