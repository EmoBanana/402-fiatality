import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Web tests cover plain helpers in Node; a component test would need `// @vitest-environment jsdom`.
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
  },
});
