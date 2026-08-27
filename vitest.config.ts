import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: ["node_modules", "dist", "coverage"],
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: true,
  },
});
