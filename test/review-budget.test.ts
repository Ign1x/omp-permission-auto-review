import { afterEach, describe, expect, jest, test } from "bun:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { modelReview, handleToolCall } from "../src/index.ts";
import { cancelReviews, ReviewCancelledError } from "../src/review-control.ts";
import { reviewBudgetMs } from "../src/timing.ts";

const event = { type: "tool_call", toolName: "bash", toolCallId: "budget", input: { command: "git status" } } as const;
const ctx = { cwd: "/tmp", hasUI: false, agent: { kind: "main" },
  model: { id: "test", provider: "fixture" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
  sessionManager: { getSessionId: () => "budget", getBranch: () => [{ type: "message", message: { role: "user", content: "Inspect" } }] },
} as any;
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
afterEach(() => jest.useRealTimers());
describe("total review budget and cancellation", () => {
  test("old per-attempt configuration inherits a finite 20-second total budget", () => {
    const config = parseConfig({ timeoutMs: 120000, maxRetries: 2 });
    expect(reviewBudgetMs(config)).toBe(20000);
    expect(() => parseConfig({ reviewTimeoutMs: 0 })).toThrow();
    expect(() => parseConfig({ reviewTimeoutMs: 1800001 })).toThrow();
  });
  test("one deadline bounds all attempts and delay even if provider ignores abort", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const pending = modelReview(event as any, ctx, { ...DEFAULT_CONFIG, timeoutMs: 5000, reviewTimeoutMs: 8000 }, (async (_m: any, _c: any, o: any) => {
      attempts++; signals.push(o.signal); return new Promise(() => {});
    }) as any).catch((e) => e);
    await settle(); jest.advanceTimersByTime(5000); await settle();
    expect(signals[0].aborted).toBe(true);
    jest.advanceTimersByTime(1000); await settle();
    expect(attempts).toBe(2);
    jest.advanceTimersByTime(2000); await settle();
    expect((await pending).message).toContain("total review budget exhausted after 8 seconds");
    expect(signals[1].aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("cancel interrupts retry sleep without another attempt or manual prompt", async () => {
    jest.useFakeTimers();
    let attempts = 0, prompts = 0;
    const controller = new AbortController();
    const pending = handleToolCall(event as any, { ...ctx, hasUI: true, ui: { notify: () => {}, confirm: async () => { prompts++; return true; } } }, {
      signal: controller.signal, config: DEFAULT_CONFIG, record: () => {},
      review: (e, c, config, signal) => modelReview(e, c, config, (async () => { attempts++; throw new Error("offline"); }) as any, { signal }),
    });
    await settle(); controller.abort(); await settle();
    expect(await pending).toMatchObject({ block: true, reason: "Permission review cancelled; tool was not executed" });
    expect(attempts).toBe(1); expect(prompts).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("cancel command acts only on its session and releases all running calls", async () => {
    const controller = new AbortController();
    const pending = handleToolCall(event as any, ctx, { signal: controller.signal, config: DEFAULT_CONFIG, record: () => {}, review: async () => new Promise(() => {}) });
    await settle();
    expect(cancelReviews({ ...ctx, sessionManager: { getSessionId: () => "other" } })).toBe(0);
    expect(cancelReviews(ctx)).toBe(1);
    expect(await pending).toMatchObject({ block: true });
    expect(cancelReviews(ctx)).toBe(0);
  });
  test("cancellation during auth prevents late provider dispatch", async () => {
    let finish!: (v: any) => void;
    let calls = 0;
    const controller = new AbortController();
    const pending = modelReview(event as any, { ...ctx, modelRegistry: { getApiKeyAndHeaders: () => new Promise((r) => { finish = r; }) } }, DEFAULT_CONFIG,
      (async () => { calls++; }) as any, { signal: controller.signal }).catch((e) => e);
    await settle(); controller.abort(new ReviewCancelledError());
    expect(await pending).toBeInstanceOf(ReviewCancelledError);
    finish({ ok: true }); await settle(); expect(calls).toBe(0);
  });
});
