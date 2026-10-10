// Optional GPU for search models. ONNX Runtime's CUDA provider ships with
// onnxruntime-node; it also needs cuDNN 9 and cuBLAS 12, which agentmux keeps in
// its own directory instead of borrowing another project's environment:
//   uv pip install --target ~/.cache/agentmux/cuda nvidia-cudnn-cu12==9.*
// The dynamic loader reads library paths only at process start, so GPU work
// runs in a process started with them: the search daemon or a reindex child.
// Without the libraries, or when CUDA fails, the CPU models answer and the
// output says so.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const LIBRARIES = ["cudnn", "cublas", "cuda_nvrtc"];
// onnxruntime-node downloads these in its postinstall, which a release
// install skips (npm --ignore-scripts); agentmux keeps a copy per version.
const PROVIDERS = ["libonnxruntime_providers_shared.so", "libonnxruntime_providers_cuda.so"];

function onnxRuntimeDirs(env) {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("onnxruntime-node/package.json"));
  const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
  const binaryDir = join(packageDir, "bin", "napi-v6", process.platform, process.arch);
  return { binaryDir, cacheDir: join(dirname(gpuLibraryRoot(env)), `onnxruntime-node-${version}`) };
}

/**
 * WHAT: Checks the ONNX Runtime CUDA provider files, restoring them from agentmux's cache.
 * WHY: Keeps a release install, which skips postinstall downloads, from silently losing the GPU.
 */
export function ensureCudaProvider(env = process.env, dirs = onnxRuntimeDirs(env)) {
  const has = (dir) => PROVIDERS.every((name) => existsSync(join(dir, name)));
  try {
    if (has(dirs.binaryDir)) {
      if (!has(dirs.cacheDir)) {
        mkdirSync(dirs.cacheDir, { recursive: true });
        for (const name of PROVIDERS) copyFileSync(join(dirs.binaryDir, name), join(dirs.cacheDir, name));
      }
      return true;
    }
    if (!has(dirs.cacheDir)) return false;
    for (const name of PROVIDERS) copyFileSync(join(dirs.cacheDir, name), join(dirs.binaryDir, name));
    return has(dirs.binaryDir);
  } catch { return false; }
}

/** WHAT: Resolves agentmux's own CUDA library directory. WHY: Keeps GPU search independent of other projects' environments. */
export const gpuLibraryRoot = (env = process.env) => env.AMUX_CUDA_LIBS || join(process.env.HOME, ".cache", "agentmux", "cuda", "nvidia");

/** WHAT: Returns an environment that lets ONNX Runtime load CUDA, or null when unavailable. WHY: Keeps a missing install a reported CPU fallback, not a crash. */
export function gpuEnv(env = process.env, { provider = () => ensureCudaProvider(env) } = {}) {
  if (env.AMUX_SEARCH_GPU === "0") return null;
  const dirs = LIBRARIES.map((name) => join(gpuLibraryRoot(env), name, "lib")).filter((dir) => existsSync(dir));
  if (!dirs.some((dir) => dir.includes("cudnn")) || !provider()) return null;
  return { ...env, LD_LIBRARY_PATH: [...dirs, env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
}

/** WHAT: Checks whether this process was started with the CUDA libraries. WHY: Keeps GPU sessions to processes that can actually load them. */
export const gpuReady = (env = process.env) => env.AMUX_SEARCH_GPU !== "0"
  && String(env.LD_LIBRARY_PATH || "").split(":").some((dir) => dir.startsWith(gpuLibraryRoot(env)) && dir.includes("cudnn"));

// ONNX Runtime 1.24.3's CUDA provider aborts inside libonnxruntime's own
// static destructors when the process exits ("corrupted double-linked list",
// SIGABRT from free() under libc exit()). It reproduces with raw
// onnxruntime-node, no transformers.js, after session.release(), and depends
// on heap layout: identical binaries abort from the global install and exit
// cleanly from a checkout. A process that used CUDA therefore ends without
// running native teardown; the driver frees its VRAM.
/** WHAT: Routes a CUDA process exit past native teardown. WHY: Keeps ONNX Runtime's exit-time abort and its crash dump out of normal shutdowns. */
export function exitAfterGpu(code = 0, { ready = gpuReady(), kill = (signal) => process.kill(process.pid, signal), exit = process.exit } = {}) {
  if (ready) kill("SIGKILL");
  else exit(code);
}

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
