/**
 * What every test gets for `react-native`: vitest.config.ts aliases the bare
 * specifier to this file, so no test file mocks it by hand.
 *
 * The real package is Flow source that neither Vite nor Node can parse, and the
 * repo has no React Native renderer. The primitives are named stand-ins that
 * carry `primitive: true` and a `displayName`, which is what
 * test/helpers/element-tree.ts keeps as nodes when it expands a hook-free view.
 * Everything else only has to exist for a client entry to load.
 *
 * `Animated` and `AccessibilityInfo` report to `recorder`, so a test can assert
 * which animation calls were made (test/plugin-launcher-running-dot.test.ts).
 * A test reads it with `import { recorder } from "./stubs/react-native"`; that
 * is the same module instance the client code gets through the alias.
 *
 * This file must not import `react-native` itself, not even for its types: they
 * pull the DOM lib into the root TypeScript program (AGENTS.md).
 */

type Component = ((props: Record<string, unknown>) => null) & { displayName: string; primitive: true };

const primitive = (name: string): Component => Object.assign(() => null, { displayName: name, primitive: true as const });

export const ActivityIndicator = primitive("ActivityIndicator");
export const Pressable = primitive("Pressable");
export const ScrollView = primitive("ScrollView");
export const Switch = primitive("Switch");
export const Text = primitive("Text");
export const TextInput = primitive("TextInput");
export const View = primitive("View");

interface Timing {
  toValue: number;
  duration: number;
  useNativeDriver: boolean;
}

/** What reached `Animated` and what `AccessibilityInfo` answers; one per test file. */
export const recorder = {
  /** What `AccessibilityInfo.isReduceMotionEnabled()` answers; swapped per test. */
  answerReduceMotion: (): Promise<boolean> => Promise.resolve(false),
  setValues: [] as number[],
  timings: [] as Timing[],
  sequences: 0,
  loops: 0,
  starts: 0,
  stops: 0,
  reset() {
    this.answerReduceMotion = () => Promise.resolve(false);
    this.setValues = [];
    this.timings = [];
    this.sequences = 0;
    this.loops = 0;
    this.starts = 0;
    this.stops = 0;
  },
};

const composite = {
  start: () => {
    recorder.starts += 1;
  },
  stop: () => {
    recorder.stops += 1;
  },
};

export const Animated = {
  // The launcher surface keeps one of these in a ref; its test uses its own `pulseValue()`.
  Value: class {
    setValue(value: number) {
      recorder.setValues.push(value);
    }
  },
  View: primitive("Animated.View"),
  timing: (_value: unknown, config: Timing) => {
    recorder.timings.push({ toValue: config.toValue, duration: config.duration, useNativeDriver: config.useNativeDriver });
    return composite;
  },
  sequence: (animations: unknown[]) => {
    recorder.sequences += animations.length > 0 ? 1 : 0;
    return composite;
  },
  loop: () => {
    recorder.loops += 1;
    return composite;
  },
};

export const AccessibilityInfo = {
  isReduceMotionEnabled: () => recorder.answerReduceMotion(),
  addEventListener: () => ({ remove() {} }),
};

export const LayoutAnimation = { configureNext() {}, Presets: {} };
export const PanResponder = { create: () => ({ panHandlers: {} }) };
export const Platform = { OS: "web" };
export const StyleSheet = { create: <T>(styles: T): T => styles, flatten: <T>(styles: T): T => styles };
export const Linking = { openURL: async () => {} };
export const useWindowDimensions = () => ({ width: 1024, height: 768 });
