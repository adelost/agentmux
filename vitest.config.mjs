import { defineConfig } from "vitest/config";

export default defineConfig({
  ...(process.env.V1D_STUDIO_TRACE_DIR ? { ssr: { resolve: { conditions: ["studio-trace", "import", "default"] } } } : {}),
  test: {
    setupFiles: ["./test/setup-env.mjs"],
  },
});
