import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ensureCudaProvider, exitAfterGpu, gpuEnv, gpuReady } from "./search-gpu.mjs";

feature("optional GPU libraries", () => {
  unit("CUDA paths are offered only when agentmux's own cuDNN exists, and can be switched off", {
    given: ["an empty and a populated library directory", () => {
      const empty = mkdtempSync(join(tmpdir(), "amux-cuda-"));
      const full = mkdtempSync(join(tmpdir(), "amux-cuda-"));
      for (const name of ["cudnn", "cublas"]) mkdirSync(join(full, name, "lib"), { recursive: true });
      return { empty, full };
    }],
    when: ["resolving environments", ({ empty, full }) => {
      const provider = { provider: () => true };
      const withLibs = gpuEnv({ AMUX_CUDA_LIBS: full, LD_LIBRARY_PATH: "/usr/lib" }, provider);
      return {
        missing: gpuEnv({ AMUX_CUDA_LIBS: empty }, provider),
        noProvider: gpuEnv({ AMUX_CUDA_LIBS: full }, { provider: () => false }),
        withLibs,
        disabled: gpuEnv({ AMUX_CUDA_LIBS: full, AMUX_SEARCH_GPU: "0" }, provider),
        ready: gpuReady(withLibs),
        plainProcess: gpuReady({ AMUX_CUDA_LIBS: full, LD_LIBRARY_PATH: "/usr/lib" }),
      };
    }],
    then: ["no libraries or opt-out means CPU; a started-with-libraries process is GPU-ready", (result, { empty, full }) => {
      try {
        expect(result.missing).toBeNull();
        expect(result.noProvider).toBeNull();
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

  unit("a release install without the CUDA provider gets it back from agentmux's cache", {
    given: ["a package without provider files and a cache with them", () => {
      const binaryDir = mkdtempSync(join(tmpdir(), "amux-ort-bin-"));
      const cacheDir = mkdtempSync(join(tmpdir(), "amux-ort-cache-"));
      for (const name of ["libonnxruntime_providers_shared.so", "libonnxruntime_providers_cuda.so"]) writeFileSync(join(cacheDir, name), name);
      return { binaryDir, cacheDir };
    }],
    when: ["ensuring the provider", (dirs) => ({ ok: ensureCudaProvider({}, dirs), again: ensureCudaProvider({}, dirs) })],
    then: ["the files are restored and the check passes", ({ ok, again }, { binaryDir, cacheDir }) => {
      try {
        expect(ok).toBe(true);
        expect(again).toBe(true);
      } finally {
        rmSync(binaryDir, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    }],
  });

  unit("a process that loaded CUDA ends without native teardown; a CPU process exits normally", {
    given: ["recorders for both ways out", () => ({ calls: [] })],
    when: ["ending a GPU and a CPU process", ({ calls }) => {
      const record = { kill: (signal) => calls.push(`kill ${signal}`), exit: (code) => calls.push(`exit ${code}`) };
      exitAfterGpu(0, { ready: true, ...record });
      exitAfterGpu(3, { ready: false, ...record });
      return calls;
    }],
    then: ["SIGKILL skips ONNX Runtime's exit-time abort; the CPU path keeps its exit code", (calls) => {
      expect(calls).toEqual(["kill SIGKILL", "exit 3"]);
    }],
  });
});
