/**
 * What every test gets for `@getpaseo/plugin/client/react-native`: vitest.config.ts
 * aliases the specifier to this file, so no test file mocks it by hand.
 *
 * The SDK's module is `export {}` at run time — the Paseo app supplies the real
 * parts when the plugin runs — so a client view that draws `<Icon>` would render
 * an undefined element. `Icon` is a named stand-in like the primitives of
 * test/stubs/react-native.ts (`primitive: true` and a `displayName`), which
 * test/helpers/element-tree.ts keeps as a node; `copyText` only has to exist.
 *
 * Only what `plugin/client` imports from the module is here.
 */

export const Icon = Object.assign(() => null, { displayName: "Icon", primitive: true as const });

export const copyText = async (): Promise<void> => {};
