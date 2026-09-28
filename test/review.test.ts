import { describe, expect, test } from "bun:test";
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
    expect(modelReview(event as any, reviewerCtx, config, badRequest)).rejects.toThrow("HTTP 400): invalid model");
    expect(attempts).toBe(1);
  });

  test("rejects oversized or invalid config", () => {
    expect(() => reviewEvidence(event as any, ctx, { ...DEFAULT_CONFIG, maxInputCharacters: 5 })).toThrow();
    expect(() => parseConfig({ maxTokens: 0 })).toThrow();
    expect(() => parseConfig({ permission: "allow" })).toThrow();
  });
});
