// Optional GPU for search models. ONNX Runtime's CUDA provider ships with
// onnxruntime-node; it also needs cuDNN 9 and cuBLAS 12, which agentmux keeps in
// its own directory instead of borrowing another project's environment:
//   uv pip install --target ~/.cache/agentmux/cuda nvidia-cudnn-cu12==9.*
// The dynamic loader reads library paths only at process start, so GPU work
// runs in a process started with them: the search daemon or a reindex child.
// Without the libraries, or when CUDA fails, the CPU models answer and the
// output says so.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIBRARIES = ["cudnn", "cublas", "cuda_nvrtc"];

/** WHAT: Resolves agentmux's own CUDA library directory. WHY: Keeps GPU search independent of other projects' environments. */
export const gpuLibraryRoot = (env = process.env) => env.AMUX_CUDA_LIBS || join(process.env.HOME, ".cache", "agentmux", "cuda", "nvidia");

/** WHAT: Returns an environment that lets ONNX Runtime load CUDA, or null when unavailable. WHY: Keeps a missing install a reported CPU fallback, not a crash. */
export function gpuEnv(env = process.env) {
  if (env.AMUX_SEARCH_GPU === "0") return null;
  const dirs = LIBRARIES.map((name) => join(gpuLibraryRoot(env), name, "lib")).filter((dir) => existsSync(dir));
  if (!dirs.some((dir) => dir.includes("cudnn"))) return null;
  return { ...env, LD_LIBRARY_PATH: [...dirs, env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
}

/** WHAT: Checks whether this process was started with the CUDA libraries. WHY: Keeps GPU sessions to processes that can actually load them. */
export const gpuReady = (env = process.env) => env.AMUX_SEARCH_GPU !== "0"
  && String(env.LD_LIBRARY_PATH || "").split(":").some((dir) => dir.startsWith(gpuLibraryRoot(env)) && dir.includes("cudnn"));

/** WHAT: Names the file a GPU reindex holds while it runs. WHY: Keeps the daemon from loading a second GPU model next to it. */
export const reindexLockPath = (dir) => join(dir, "reindex.lock");

/** WHAT: Checks whether a live process holds the reindex lock. WHY: Prevents two GPU models from exceeding the VRAM budget. */
export function reindexRunning(dir) {
  try {
    const pid = Number(readFileSync(reindexLockPath(dir), "utf8"));
    process.kill(pid, 0);
    return pid !== process.pid;
  } catch { return false; }
}

/** WHAT: Stores this process as the running reindex until released. WHY: Keeps the daemon on CPU models while the GPU embeds. */
export function holdReindexLock(dir) {
  writeFileSync(reindexLockPath(dir), String(process.pid));
  return () => rmSync(reindexLockPath(dir), { force: true });
}
