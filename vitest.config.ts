import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// What every test project shares. The projects and the files each one runs are
// in vitest.workspace.ts; there is no `include` here because `extends` merges
// arrays, so a project would run its own files plus these.
export default defineConfig({
  resolve: {
    // `react-native` is Flow source that neither Vite nor Node can parse, and the
    // repo has no React Native renderer: every test that loads a client `.tsx`
    // gets the named stand-ins in test/stubs/react-native.ts instead. The SDK's
    // `@getpaseo/plugin/client/react-native` is empty outside the Paseo app, so
    // its `Icon` and `copyText` come from test/stubs/paseo-react-native.ts.
    alias: [
      { find: /^react-native$/, replacement: fileURLToPath(new URL("./test/stubs/react-native.ts", import.meta.url)) },
      { find: /^@getpaseo\/plugin\/client\/react-native$/, replacement: fileURLToPath(new URL("./test/stubs/paseo-react-native.ts", import.meta.url)) },
    ],
  },
  test: {
    setupFiles: ["test/setup/no-real-installers.ts"],
    environment: "node",
    // Many suites spawn real child processes (git, fake command-line tools,
    // `tsc`). On a busy machine the 5 s default flakes them without
    // any behaviour being wrong; a genuine hang still fails after 30 s.
    testTimeout: 30_000,
  },
});
