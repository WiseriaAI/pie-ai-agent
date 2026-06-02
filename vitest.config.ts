import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    globals: false,
    // happy-dom is required for React hook / component tests (M1-U2+).
    // Pure storage tests (M1-U1) are environment-agnostic and run fine
    // here too. Cost: ~5ms boot per file vs node.
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "eval/**/*.test.ts"],
  },
});
