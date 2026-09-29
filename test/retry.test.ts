import { afterEach, describe, expect, jest, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Decision } from "../src/review.ts";
import { handleToolCall, modelReview } from "../src/index.ts";

const event = { type: "tool_call", toolCallId: "fixture", toolName: "bash", input: { command: "git status" } } as const;
const decision = (outcome: Decision["outcome"] = "allow"): Decision => ({ outcome, risk_level: "low", user_authorization: "high", rationale: "Local file listing" });
const response = (outcome: Decision["outcome"] = "allow") => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(decision(outcome)) }] });
const ctx = {
  cwd: "/tmp", agent: { kind: "main" }, hasUI: true,
  models: { resolve: () => ({ provider: "fixture", id: "reviewer", reasoning: true }) },
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) },
  sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "List files" } }] },
  ui: { notify: () => {}, confirm: async () => false },
} as any;
const config = { ...DEFAULT_CONFIG, failurePolicy: "ask" as const, model: "fixture/reviewer", timeoutMs: 60000, reviewTimeoutMs: 300000 };
// Flush the async auth, provider, race and handler continuations before advancing timers.
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => jest.useRealTimers());

describe("review retries", () => {
  test("explicitly requests low thinking and never disables it", async () => {
    let options: any;
    await modelReview(event as any, ctx, config, (async (_model: any, _context: any, supplied: any) => {
      options = supplied;
      return response();
    }) as any);
    expect(options.reasoning).toBe("low");
    expect(options.disableReasoning).toBeUndefined();
    expect(options.forceReasoningOff).toBeUndefined();
  });

  test("honors configured thinking and omits it for non-reasoning models", async () => {
    const efforts: unknown[] = [];
    const complete = (async (_m: any, _c: any, options: any) => { efforts.push(options.reasoning); return response(); }) as any;
    await modelReview(event as any, ctx, { ...config, reasoning: "high" }, complete);
    await modelReview(event as any, { ...ctx, models: { resolve: () => ({ provider: "fixture", id: "plain", reasoning: false }) } }, config, complete);
    expect(efforts).toEqual(["high", undefined]);
  });

  test.each(["deny"] as const)("a valid %s is final and is never retried", async (outcome) => {
    let requests = 0;
    let prompts = 0;
    const result = await handleToolCall(event as any, { ...ctx, ui: { ...ctx.ui, confirm: async () => { prompts++; return false; } } }, {
      config, record: () => {},
      review: (event, ctx, config) => modelReview(event, ctx, config, (async () => { requests++; return response(outcome); }) as any),
    });
    expect(result).toMatchObject({ block: true });
    expect(requests).toBe(1);
    expect(prompts).toBe(0);
  });

  test("provider abort and malformed output retry up to the configured limit", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const pending = modelReview(event as any, ctx, config, (async () => {
      attempts++;
      if (attempts === 1) return { stopReason: "aborted", errorMessage: "Request was aborted" };
      if (attempts === 2) return { stopReason: "stop", content: [{ type: "text", text: "invalid JSON" }] };
      return response();
    }) as any);
    await settle();
    expect(attempts).toBe(1);
    jest.advanceTimersByTime(1000); await settle();
    expect(attempts).toBe(2);
    jest.advanceTimersByTime(1000); await settle();
    expect(await pending).toEqual(decision());
    expect(attempts).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["network", "length", "empty"])("retries %s failures", async (kind) => {
    jest.useFakeTimers();
    let attempts = 0;
    const pending = modelReview(event as any, ctx, config, (async () => {
      if (++attempts > 1) return response();
      if (kind === "network") throw new Error("Connection reset");
      return kind === "length" ? { stopReason: "length" } : { stopReason: "stop", content: [] };
    }) as any);
    await settle(); jest.advanceTimersByTime(1000); await settle();
    expect(await pending).toEqual(decision());
    expect(attempts).toBe(2);
  });

  test("timeout retries get fresh signals and a full independent budget", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    let finish!: (value: unknown) => void;
    const pending = modelReview(event as any, ctx, config, (async (_m: any, _c: any, options: any) => {
      signals.push(options.signal);
      return new Promise((resolve) => { if (signals.length === 2) finish = resolve; });
    }) as any);
    await settle();
    jest.advanceTimersByTime(60000); await settle();
    expect(signals[0].aborted).toBe(true);
    jest.advanceTimersByTime(1000); await settle();
    expect(signals).toHaveLength(2);
    expect(signals[1]).not.toBe(signals[0]);
    jest.advanceTimersByTime(59000); await settle();
    expect(signals[1].aborted).toBe(false);
    finish(response());
    expect(await pending).toEqual(decision());
    jest.advanceTimersByTime(60000);
    expect(signals[1].aborted).toBe(false);
  });

  test("asks once only after all attempts fail; late allows cannot override the answer", async () => {
    jest.useFakeTimers();
    const finishes: Array<(value: unknown) => void> = [];
    const messages: string[] = [];
    const records: string[] = [];
    const pending = handleToolCall(event as any, { ...ctx, ui: { ...ctx.ui, confirm: async (_title: string, message: string) => { messages.push(message); return false; } } }, {
      config, record: (_event, outcome) => records.push(outcome),
      review: (event, ctx, config) => modelReview(event, ctx, config, (async () => new Promise((resolve) => finishes.push(resolve))) as any),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await settle();
      expect(messages).toHaveLength(0);
      jest.advanceTimersByTime(60000); await settle();
      if (attempt < 2) { jest.advanceTimersByTime(1000); await settle(); }
    }
    expect(await pending).toMatchObject({ block: true });
    expect(finishes).toHaveLength(3);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("after 3 attempt(s)");
    expect(messages[0]).toContain("total review budget exhausted after 182 seconds");
    for (const finish of finishes) finish(response());
    await settle();
    expect(records).toEqual(["user_deny_unavailable"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("no UI still exhausts retries and blocks", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const pending = handleToolCall(event as any, { ...ctx, hasUI: false }, {
      config: { ...config, maxRetries: 1 }, record: () => {},
      review: (event, ctx, config) => modelReview(event, ctx, config, (async () => { attempts++; throw new Error("offline"); }) as any),
    });
    await settle(); jest.advanceTimersByTime(1000); await settle();
    expect(await pending).toMatchObject({ block: true });
    expect(attempts).toBe(2);
  });

  test("zero retries reports a local timeout even if SDK resolves aborted synchronously", async () => {
    jest.useFakeTimers();
    const pending = modelReview(event as any, ctx, { ...config, maxRetries: 0 }, (async (_m: any, _c: any, options: any) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ stopReason: "aborted" }), { once: true });
    })) as any).catch((error) => error);
    await settle(); jest.advanceTimersByTime(60000); await settle();
    const error = await pending;
    expect(error.message).toContain("after 1 attempt(s)");
    expect(error.message).toContain("total review budget exhausted after 60 seconds");
  });

  test("late authentication cannot dispatch a request after its attempt expired", async () => {
    jest.useFakeTimers();
    let finish!: (value: any) => void;
    let requests = 0;
    const pending = modelReview(event as any, { ...ctx, modelRegistry: { getApiKeyAndHeaders: () => new Promise((resolve) => { finish = resolve; }) } },
      { ...config, maxRetries: 0 }, (async () => { requests++; return response(); }) as any).catch((error) => error);
    jest.advanceTimersByTime(60000); await settle();
    expect((await pending).message).toContain("total review budget exhausted");
    finish({ ok: true }); await settle();
    expect(requests).toBe(0);
  });

  test("permanent authentication failure stops without retry", async () => {
    let attempts = 0;
    await expect(modelReview(event as any, { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => { attempts++; return { ok: false, error: "missing credentials" }; } } }, config)).rejects.toThrow("authentication failed");
    expect(attempts).toBe(1);
  });
});
