import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, feature, unit } from "bdd-vitest";
import { pinRuntimeExecutable } from "./runtime-helper.mjs";

feature("immutable runtime helpers", () => {
  unit("a pinned executable survives source-package removal", {
    then: ["late process launches use the immutable copy and retain exact bytes", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-runtime-helper-"));
      try {
        const source = join(root, "package", "helper.sh");
        const runtimeRoot = join(root, "runtime");
        mkdirSync(join(root, "package"), { recursive: true });
        writeFileSync(source, "#!/bin/sh\nprintf 'helper:%s:%s\\n' \"$1\" \"$2\"\n", { mode: 0o700 });
        chmodSync(source, 0o700);

        const pinned = pinRuntimeExecutable({ sourcePath: source, runtimeRoot });
        const expectedBytes = readFileSync(source);
        rmSync(join(root, "package"), { recursive: true, force: true });

        expect(readFileSync(pinned.path)).toEqual(expectedBytes);
        expect(statSync(pinned.path).mode & 0o777).toBe(0o700);
        expect(execFileSync(pinned.path, ["voice.ogg", "sv"], { encoding: "utf8" }))
          .toBe("helper:voice.ogg:sv\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("different helper bytes receive different immutable paths", {
    then: ["an old bridge keeps its exact executable across a later release", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-runtime-helper-"));
      try {
        const source = join(root, "helper.sh");
        const runtimeRoot = join(root, "runtime");
        writeFileSync(source, "#!/bin/sh\necho old\n", { mode: 0o700 });
        const oldPinned = pinRuntimeExecutable({ sourcePath: source, runtimeRoot });
        writeFileSync(source, "#!/bin/sh\necho new\n", { mode: 0o700 });
        const newPinned = pinRuntimeExecutable({ sourcePath: source, runtimeRoot });

        expect(newPinned.path).not.toBe(oldPinned.path);
        expect(execFileSync(oldPinned.path, { encoding: "utf8" })).toBe("old\n");
        expect(execFileSync(newPinned.path, { encoding: "utf8" })).toBe("new\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });
});
