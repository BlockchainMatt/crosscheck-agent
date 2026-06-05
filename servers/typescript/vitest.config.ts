import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    // The parity fixtures are large JSON files; let it.each cases enumerate
    // without truncating names.
    chaiConfig: { truncateThreshold: 0 },
  },
});
