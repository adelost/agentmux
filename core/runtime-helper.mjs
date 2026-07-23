import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * WHAT: Builds an immutable, content-addressed copy of a late-spawned helper.
 * WHY: Prevents global package replacement from removing helpers used by the live bridge.
 */
export function pinRuntimeExecutable({ sourcePath, runtimeRoot, name = null }) {
  const source = resolve(String(sourcePath || ""));
  const root = resolve(String(runtimeRoot || ""));
  const bytes = readFileSync(source);
  const contentSha256 = sha256(bytes);
  const fileName = name || basename(source);
  const directory = join(root, contentSha256);
  const path = join(directory, fileName);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) !== contentSha256) {
      throw new Error(`runtime helper hash mismatch at ${path}`);
    }
    chmodSync(path, 0o700);
    return { path, contentSha256 };
  }

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o700, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o700);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, contentSha256 };
}
