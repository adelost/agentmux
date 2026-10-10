import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gpuEnv, gpuReady } from "./search-gpu.mjs";

feature("optional GPU libraries", () => {
  unit("CUDA paths are offered only when agentmux's own cuDNN exists, and can be switched off", {
    given: ["an empty and a populated library directory", () => {
      const empty = mkdtempSync(join(tmpdir(), "amux-cuda-"));
      const full = mkdtempSync(join(tmpdir(), "amux-cuda-"));
      for (const name of ["cudnn", "cublas"]) mkdirSync(join(full, name, "lib"), { recursive: true });
      return { empty, full };
    }],
    when: ["resolving environments", ({ empty, full }) => {
      const withLibs = gpuEnv({ AMUX_CUDA_LIBS: full, LD_LIBRARY_PATH: "/usr/lib" });
      return {
        missing: gpuEnv({ AMUX_CUDA_LIBS: empty }),
        withLibs,
        disabled: gpuEnv({ AMUX_CUDA_LIBS: full, AMUX_SEARCH_GPU: "0" }),
        ready: gpuReady(withLibs),
        plainProcess: gpuReady({ AMUX_CUDA_LIBS: full, LD_LIBRARY_PATH: "/usr/lib" }),
      };
    }],
    then: ["no libraries or opt-out means CPU; a started-with-libraries process is GPU-ready", (result, { empty, full }) => {
      try {
        expect(result.missing).toBeNull();
        expect(result.disabled).toBeNull();
        expect(result.withLibs.LD_LIBRARY_PATH).toBe(`${join(full, "cudnn", "lib")}:${join(full, "cublas", "lib")}:/usr/lib`);
        expect(result.ready).toBe(true);
        expect(result.plainProcess).toBe(false);
      } finally {
        rmSync(empty, { recursive: true, force: true });
        rmSync(full, { recursive: true, force: true });
      }
    }],
  });
});
