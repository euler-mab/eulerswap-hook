import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Exclude Solidity submodule trees (OpenZeppelin etc.) which contain .test.js files
    exclude: ["**/node_modules/**", "contracts/**"],
  },
});
