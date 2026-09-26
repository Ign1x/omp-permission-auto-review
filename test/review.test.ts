import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { handleToolCall, reviewEvidence } from "../src/index.ts";
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

  test("fails closed when review fails or UI is absent", async () => {
    const options = { config: DEFAULT_CONFIG, record: record as any };
    expect(await handleToolCall(event as any, ctx, { ...options, review: async () => { throw new Error("offline"); } })).toMatchObject({ block: true });
    expect(await handleToolCall(event as any, { ...ctx, hasUI: false }, { ...options, review: async () => decision("defer") })).toMatchObject({ block: true });
  });

  test("rejects oversized or invalid config", () => {
    expect(() => reviewEvidence(event as any, ctx, { ...DEFAULT_CONFIG, maxInputCharacters: 5 })).toThrow();
    expect(() => parseConfig({ maxTokens: 0 })).toThrow();
    expect(() => parseConfig({ permission: "allow" })).toThrow();
  });
});
