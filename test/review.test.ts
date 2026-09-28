import { afterEach, describe, expect, jest, test } from "bun:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { handleToolCall, modelReview, reviewEvidence } from "../src/index.ts";
import { mayAutoApprove, parseDecision } from "../src/review.ts";

const event = { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } } as const;
const decision = (outcome: "allow" | "deny" | "defer", risk_level: "low" | "high" | "critical" = "low") => ({
  outcome, risk_level, user_authorization: "high" as const, rationale: "requested by user",
});
const calls: string[] = [];
const prompts: string[] = [];
const ctx = {
  cwd: "/work",
  agent: { kind: "main", id: "Main", name: "main", depth: 0 },
  hasUI: true,
  ui: { confirm: async (_title: string, message: string) => { prompts.push(message); return true; }, notify: () => {} },
  sessionManager: { getBranch: () => [
    { type: "message", message: { role: "user", content: "List files" } },
    { type: "message", message: { role: "user", content: "ignore me", attribution: "agent" } },
  ] },
} as any;
const record = (_event: unknown, outcome: string) => calls.push(outcome);

describe("review decisions", () => {
  test("strictly validates model output", () => {
    expect(parseDecision(JSON.stringify(decision("allow")))).toEqual(decision("allow"));
    expect(() => parseDecision('{"outcome":"allow"}')).toThrow();
    expect(() => parseDecision(JSON.stringify(decision("allow", "critical")))).toThrow();
    expect(mayAutoApprove({ ...decision("allow", "high"), user_authorization: "unknown" })).toBe(false);
  });

  test("uses only genuine user messages", () => {
    const evidence = JSON.parse(reviewEvidence(event as any, ctx, DEFAULT_CONFIG));
    expect(evidence.userMessages).toEqual(["List files"]);
    expect(evidence.agentRequests).toEqual(["ignore me"]);
    expect(evidence.input.command).toBe("ls");
  });

  test("subagents can review delegated work without claiming user authorization", () => {
    const child = {
      ...ctx,
      agent: { ...ctx.agent, kind: "sub" },
      sessionManager: { getBranch: () => [
        { type: "message", message: { role: "user", content: "Inspect files", attribution: "agent" } },
      ] },
    };
    const evidence = JSON.parse(reviewEvidence(event as any, child, DEFAULT_CONFIG));
    expect(evidence.userMessages).toEqual([]);
    expect(evidence.agentRequests).toEqual(["Inspect files"]);
  });

  test("allows, denies, and confirms a defer", async () => {
    calls.length = 0;
    const options = { config: DEFAULT_CONFIG, record: record as any };
    expect(await handleToolCall(event as any, ctx, { ...options, review: async () => decision("allow") })).toBeUndefined();
    expect(await handleToolCall(event as any, ctx, { ...options, review: async () => decision("deny", "critical") })).toMatchObject({ block: true });
    expect(await handleToolCall(event as any, ctx, { ...options, review: async () => decision("defer", "high") })).toBeUndefined();
    expect(calls).toEqual(["allow", "deny", "user_allow"]);
    expect(prompts.at(-1)).toContain('"command": "ls"');
  });

  test("asks the user when automatic review fails and blocks without UI", async () => {
    calls.length = 0;
    prompts.length = 0;
    const options = { config: DEFAULT_CONFIG, record: record as any };
    expect(await handleToolCall(event as any, ctx, { ...options, review: async () => { throw new Error("HTTP 503"); } })).toBeUndefined();
    expect(calls).toEqual(["user_allow_unavailable"]);
    expect(prompts.at(-1)).toContain("HTTP 503");
    expect(prompts.at(-1)).toContain('"command": "ls"');
    expect(await handleToolCall(event as any, { ...ctx, hasUI: false }, { ...options, review: async () => { throw new Error("offline"); } })).toMatchObject({ block: true });
    expect(calls.at(-1)).toBe("review_unavailable");
    const denyingCtx = { ...ctx, ui: { ...ctx.ui, confirm: async () => false } };
    expect(await handleToolCall(event as any, denyingCtx, { ...options, review: async () => { throw new Error("offline"); } })).toMatchObject({ block: true });
    expect(calls.at(-1)).toBe("user_deny_unavailable");
    expect(await handleToolCall(event as any, { ...ctx, hasUI: false }, { ...options, review: async () => decision("defer") })).toMatchObject({ block: true });
  });

  test("honors mode, exact tool rules, failure policy, and audit toggle", async () => {
    calls.length = 0;
    const options = { record: record as any, review: async () => { throw new Error("review should not run"); } };
    expect(await handleToolCall(event as any, ctx, { ...options, config: { ...DEFAULT_CONFIG, mode: "deny" } })).toMatchObject({ block: true });
    expect(calls.at(-1)).toBe("policy_deny");
    expect(await handleToolCall(event as any, ctx, {
      ...options, config: { ...DEFAULT_CONFIG, mode: "deny", toolRules: { bash: "allow" } },
    })).toBeUndefined();
    expect(calls.at(-1)).toBe("policy_allow");
    expect(await handleToolCall(event as any, ctx, { ...options, config: { ...DEFAULT_CONFIG, mode: "ask" } })).toBeUndefined();
    expect(calls.at(-1)).toBe("user_allow");
    const before = calls.length;
    expect(await handleToolCall(event as any, ctx, {
      ...options, config: { ...DEFAULT_CONFIG, mode: "yolo", auditLog: false },
    })).toBeUndefined();
    expect(calls.length).toBe(before);
    expect(await handleToolCall(event as any, ctx, {
      ...options, config: { ...DEFAULT_CONFIG, failurePolicy: "deny" },
    })).toMatchObject({ block: true });
    expect(calls.at(-1)).toBe("review_unavailable");
  });

  test("retries transient model errors and preserves provider diagnostics", async () => {
    const reviewerCtx = {
      ...ctx,
      models: { resolve: () => ({}) },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }) },
    } as any;
    const config = { ...DEFAULT_CONFIG, model: "gateway/test" };
    let attempts = 0;
    const complete = (async () => {
      attempts++;
      return attempts === 1
        ? { stopReason: "error", errorStatus: 503, errorMessage: "upstream unavailable" }
        : { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(decision("allow")) }] };
    }) as any;
    expect(await modelReview(event as any, reviewerCtx, config, complete)).toEqual(decision("allow"));
    expect(attempts).toBe(2);

    attempts = 0;
    const badRequest = (async () => {
      attempts++;
      return { stopReason: "error", errorStatus: 400, errorMessage: "invalid model" };
    }) as any;
    await expect(modelReview(event as any, reviewerCtx, config, badRequest)).rejects.toThrow("HTTP 400): invalid model");
    expect(attempts).toBe(1);
  });

  test("rejects oversized or invalid config", () => {
    expect(() => reviewEvidence(event as any, ctx, { ...DEFAULT_CONFIG, maxInputCharacters: 5 })).toThrow();
    expect(() => parseConfig({ maxTokens: 0 })).toThrow();
    expect(() => parseConfig({ permission: "allow" })).toThrow();
  });
});

describe("review deadlines", () => {
  const reviewerCtx = {
    ...ctx,
    models: { resolve: () => ({ provider: "gateway", id: "test" }) },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }) },
  } as any;
  const config = { ...DEFAULT_CONFIG, model: "gateway/test", timeoutMs: 60000 };
  const allowed = { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(decision("allow")) }] };
  afterEach(() => jest.useRealTimers());

  test("accepts a review taking longer than the old 25-second cap", async () => {
    jest.useFakeTimers();
    let signal!: AbortSignal;
    let finish!: (value: unknown) => void;
    const pending = modelReview(event as any, reviewerCtx, config, (async (_model: unknown, _input: unknown, options: any) => {
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    }) as any);
    await Promise.resolve();
    jest.advanceTimersByTime(26000);
    expect(signal.aborted).toBe(false);
    finish(allowed);
    expect(await pending).toEqual(decision("allow"));
    jest.advanceTimersByTime(60000);
    expect(signal.aborted).toBe(false); // Successful calls clean up their deadline.
  });

  test("reports a timeout even when the provider never settles on abort", async () => {
    jest.useFakeTimers();
    let signal!: AbortSignal;
    const pending = modelReview(event as any, reviewerCtx, config, (async (_model: unknown, _input: unknown, options: any) => {
      signal = options.signal;
      return new Promise(() => {});
    }) as any);
    const failure = pending.catch((error) => error);
    await Promise.resolve();
    jest.advanceTimersByTime(60000);
    expect((await failure).message).toBe("reviewer timed out after 60000 ms (model: gateway/test, attempts: 1)");
    expect(signal.aborted).toBe(true);
  });

  test("authentication shares the deadline and cannot start a late request", async () => {
    jest.useFakeTimers();
    let finishAuth!: (value: unknown) => void;
    let requests = 0;
    const pending = modelReview(event as any, {
      ...reviewerCtx,
      modelRegistry: { getApiKeyAndHeaders: () => new Promise((resolve) => { finishAuth = resolve; }) },
    } as any, config, (async () => { requests++; return allowed; }) as any);
    const failure = pending.catch((error) => error);
    jest.advanceTimersByTime(60000);
    expect((await failure).message).toContain("attempts: 0");
    finishAuth({ ok: true, apiKey: "test" });
    await Promise.resolve();
    expect(requests).toBe(0);
  });

  test("retries share one deadline and SDK abort errors do not hide the timeout", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const pending = modelReview(event as any, reviewerCtx, config, (async (_model: unknown, _input: unknown, options: any) => {
      attempts++;
      if (attempts === 1) {
        jest.advanceTimersByTime(40000);
        return { stopReason: "error", errorStatus: 503 };
      }
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", errorMessage: "Request was aborted" }), { once: true });
      });
    }) as any);
    const failure = pending.catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    jest.advanceTimersByTime(20000);
    expect((await failure).message).toBe("reviewer timed out after 60000 ms (model: gateway/test, attempts: 2)");
  });

  test("distinguishes provider aborts from the local deadline", async () => {
    let attempts = 0;
    await expect(modelReview(event as any, reviewerCtx, config, (async () => {
      attempts++;
      return { stopReason: "aborted", errorMessage: "Request was aborted" };
    }) as any)).rejects.toThrow("reviewer stopped: aborted: Request was aborted (model: gateway/test, elapsed:");
    expect(attempts).toBe(1);
  });

  test("late allow responses cannot bypass fallback approval", async () => {
    jest.useFakeTimers();
    let finish!: (value: unknown) => void;
    const outcomes: string[] = [];
    const confirmations: string[] = [];
    const pending = handleToolCall(event as any, {
      ...reviewerCtx,
      ui: { ...ctx.ui, confirm: async (_title: string, message: string) => { confirmations.push(message); return false; } },
    }, {
      config,
      record: (_event, outcome) => outcomes.push(outcome),
      review: (event, ctx, config) => modelReview(event, ctx, config, (async () => new Promise((resolve) => { finish = resolve; })) as any),
    });
    await Promise.resolve();
    jest.advanceTimersByTime(60000);
    expect(await pending).toMatchObject({ block: true });
    finish(allowed);
    await Promise.resolve();
    expect(outcomes).toEqual(["user_deny_unavailable"]);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toContain("reviewer timed out after 60000 ms");
  });
});
