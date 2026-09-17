import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup/no-real-installers.ts"],
    environment: "node",
    // Many suites spawn real child processes (fake `paseo`, `npx`, packed
    // tarball installs). On a busy machine the 5 s default flakes them without
    // any behaviour being wrong; a genuine hang still fails after 30 s.
    testTimeout: 30_000,
  },
});
