import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WP-238.2 (delta 20260917e §4.2): the dot beside a project name that says a bm
 * agent is working in that workspace right now.
 *
 * The repo has no React Native renderer, so the surface is never rendered and
 * `react-native` is replaced here by a recording stand-in. That stand-in is the
 * point of the file: the three states of the dot are decided by
 * `runningDotState`, and what reaches `Animated` is decided by `applyDotPulse`,
 * so "reduced motion starts no animation" is an assertion about calls that were
 * never made, not about a rendered frame.
 */

const rn = vi.hoisted(() => {
  interface Timing {
    toValue: number;
    duration: number;
    useNativeDriver: boolean;
  }
  return {
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
});

vi.mock("react-native", () => {
  const composite = {
    start: () => {
      rn.starts += 1;
    },
    stop: () => {
      rn.stops += 1;
    },
  };
  return {
    AccessibilityInfo: { isReduceMotionEnabled: () => rn.answerReduceMotion() },
    ActivityIndicator: () => null,
    Animated: {
      // The surface keeps one of these in a ref; tests use `pulseValue()`.
      Value: class {
        setValue(value: number) {
          rn.setValues.push(value);
        }
      },
      View: () => null,
      timing: (_value: unknown, config: { toValue: number; duration: number; useNativeDriver: boolean }) => {
        rn.timings.push({ toValue: config.toValue, duration: config.duration, useNativeDriver: config.useNativeDriver });
        return composite;
      },
      sequence: (animations: unknown[]) => {
        rn.sequences += animations.length > 0 ? 1 : 0;
        return composite;
      },
      loop: () => {
        rn.loops += 1;
        return composite;
      },
    },
    Pressable: () => null,
    ScrollView: () => null,
    Text: () => null,
    TextInput: () => null,
    View: () => null,
  };
});

/**
 * The slice of `Animated.Value` the pulse touches, declared here rather than
 * imported: a test file that imports `react-native` — even only for its types
 * through a value import — drags React Native's global declarations into the
 * root TypeScript program, where `setTimeout` then returns a number and
 * unrelated Node files stop compiling.
 */
interface PulseValue {
  setValue(value: number): void;
}

/** A stand-in for the value the surface keeps in a ref, recording what lands on it. */
function pulseValue(): PulseValue {
  return {
    setValue(value) {
      rn.setValues.push(value);
    },
  };
}

// The root tsconfig has no `jsx` setting, so the .tsx surface is loaded through
// a non-literal specifier that `tsc --noEmit` does not resolve — same shape as
// `plugin-launcher.test.ts`.
const surfacePath = "../plugin/client/launcher.tsx";
const { applyDotPulse, readReduceMotion, runningDotState } = (await import(surfacePath)) as {
  applyDotPulse: (
    value: PulseValue,
    state: { total: number; animate: boolean; opacity: number; label: string; tone: string },
  ) => (() => void) | undefined;
  readReduceMotion: () => Promise<boolean>;
  runningDotState: (
    counts: { manager: number; worker: number; reviewer: number } | undefined,
    reduceMotion: boolean,
  ) => { total: number; animate: boolean; opacity: number; label: string; tone: string } | null;
};

describe("the running dot of a workspace row", () => {
  it("pulses and names every role that is running", () => {
    const state = runningDotState({ manager: 0, worker: 1, reviewer: 1 }, false);
    expect(state).toEqual({ total: 2, animate: true, opacity: 1, label: "1 Worker, 1 Reviewer", tone: "success" });

    // Only a Reviewer running is the case a Worker-only count would miss.
    expect(runningDotState({ manager: 0, worker: 0, reviewer: 1 }, false)).toMatchObject({
      animate: true,
      label: "1 Reviewer",
    });
    expect(runningDotState({ manager: 1, worker: 2, reviewer: 0 }, false)).toMatchObject({
      total: 3,
      label: "1 Manager, 2 Workers",
    });
  });

  it("is still and dim when nothing runs", () => {
    const state = runningDotState({ manager: 0, worker: 0, reviewer: 0 }, false);
    expect(state?.animate).toBe(false);
    expect(state?.opacity).toBeLessThan(1);
    expect(state?.tone).toBe("muted");
    // The dim dot draws no text, so these words exist for the screen reader.
    expect(state?.label).toBe("No Beads agent running");
  });

  it("shows no dot at all before the overview has answered for that row", () => {
    expect(runningDotState(undefined, false)).toBeNull();
    expect(runningDotState(undefined, true)).toBeNull();
  });

  it("loops the opacity and never asks for the native driver", () => {
    rn.reset();
    const value = pulseValue();
    const state = runningDotState({ manager: 0, worker: 1, reviewer: 0 }, false)!;

    const stop = applyDotPulse(value, state);

    expect(rn.loops).toBe(1);
    expect(rn.sequences).toBe(1);
    expect(rn.starts).toBe(1);
    expect(rn.timings).toHaveLength(2);
    // Paseo's renderer is react-native-web, where a native driver is not there
    // to drive anything (P3).
    for (const timing of rn.timings) expect(timing.useNativeDriver).toBe(false);
    // The pulse dips and comes back, so the dot reads as a breath.
    expect(rn.timings.map((timing) => timing.toValue)).toEqual([expect.any(Number), 1]);
    expect(rn.timings[0]!.toValue).toBeLessThan(1);
    expect(rn.timings.every((timing) => timing.duration > 0)).toBe(true);
    // The dot rests at full opacity while something runs.
    expect(rn.setValues).toEqual([1]);

    expect(stop).toBeTypeOf("function");
    stop!();
    expect(rn.stops).toBe(1);
  });

  it("starts no animation when the user asked for reduced motion", () => {
    rn.reset();
    const value = pulseValue();
    const state = runningDotState({ manager: 0, worker: 1, reviewer: 1 }, true)!;

    // The signal stays: a solid dot, with the same words.
    expect(state.opacity).toBe(1);
    expect(state.tone).toBe("success");
    expect(state.label).toBe("1 Worker, 1 Reviewer");
    expect(state.animate).toBe(false);

    expect(applyDotPulse(value, state)).toBeUndefined();
    expect(rn.loops).toBe(0);
    expect(rn.sequences).toBe(0);
    expect(rn.timings).toEqual([]);
    expect(rn.starts).toBe(0);
    expect(rn.setValues).toEqual([1]);
  });

  it("starts no animation for an idle workspace either", () => {
    rn.reset();
    const value = pulseValue();
    const state = runningDotState({ manager: 0, worker: 0, reviewer: 0 }, false)!;

    expect(applyDotPulse(value, state)).toBeUndefined();
    expect(rn.loops).toBe(0);
    expect(rn.starts).toBe(0);
    expect(rn.setValues).toEqual([state.opacity]);
    expect(state.opacity).toBeLessThan(1);
  });
});

describe("reading the reduced-motion preference", () => {
  it("takes the answer of the operating system", async () => {
    rn.reset();
    rn.answerReduceMotion = () => Promise.resolve(true);
    expect(await readReduceMotion()).toBe(true);
    rn.answerReduceMotion = () => Promise.resolve(false);
    expect(await readReduceMotion()).toBe(false);
  });

  it("treats a host that cannot answer as no preference, not as reduce motion", async () => {
    rn.reset();
    rn.answerReduceMotion = () => Promise.reject(new Error("no accessibility bridge"));
    await expect(readReduceMotion()).resolves.toBe(false);
  });
});

describe("the dot on the workspace row", () => {
  // Without a renderer nothing else proves the helpers are wired to a row, and
  // an unwired dot would leave every test above green.
  it("is rendered per row from the overview's runningAgents", () => {
    const source = readFileSync(fileURLToPath(new URL(surfacePath, import.meta.url)), "utf8");
    expect(source).toMatch(/<RunningDot\b[^>]*counts=\{overviewById\.get\(workspace\.id\)\?\.runningAgents\}/);
    expect(source).toMatch(/<Animated\.View\b/);
  });
});
