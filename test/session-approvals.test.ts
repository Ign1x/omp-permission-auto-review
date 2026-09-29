import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { SessionApprovals } from "../src/session-approvals.ts";
import { handleToolCall } from "../src/index.ts";
import { requestApproval } from "../src/approval.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "omp-session-")); dirs.push(cwd);
  const ctx = { cwd, agent: { kind: "main", id: "Main" }, hasUI: true, sessionManager: { getSessionId: () => "session-1" }, ui: { select: async () => "Allow exact call for this session", confirm: async () => true, notify: () => {} } } as any;
  const event = { type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "bun test" } } as const;
  return { ctx, event, approvals: new SessionApprovals() };
}
describe("deliberate session approvals", () => {
  test("only explicit session approval skips subsequent review and can be revoked", async () => {
    const { ctx, event, approvals } = fixture();
    let reviews = 0;
    const options = { config: DEFAULT_CONFIG, approvals, record: () => {}, review: async () => { reviews++; return { outcome: "defer", risk_level: "low", user_authorization: "unknown", rationale: "Please approve" } as const; } };
    expect(await handleToolCall(event as any, ctx, options)).toBeUndefined();
    expect(await handleToolCall({ ...event, toolCallId: "2" } as any, ctx, options)).toBeUndefined();
    expect(reviews).toBe(1);
    const grants = approvals.list(ctx, DEFAULT_CONFIG);
    expect(grants).toHaveLength(1);
    expect(JSON.stringify(grants)).not.toContain("bun test");
    approvals.revoke(ctx, grants[0].id);
    await handleToolCall(event as any, ctx, options);
    expect(reviews).toBe(2);
  });
  test("scope binds exact input, cwd, session, agent and effective configuration", () => {
    const { ctx, event, approvals } = fixture();
    approvals.grant(event, ctx, DEFAULT_CONFIG);
    expect(approvals.has(event, ctx, DEFAULT_CONFIG)).toBe(true);
    expect(approvals.has({ ...event, input: { command: "bun test --watch" } }, ctx, DEFAULT_CONFIG)).toBe(false);
    expect(approvals.has(event, { ...ctx, cwd: tmpdir() }, DEFAULT_CONFIG)).toBe(false);
    expect(approvals.has(event, { ...ctx, agent: { kind: "sub", id: "Main" } }, DEFAULT_CONFIG)).toBe(false);
    expect(approvals.has(event, { ...ctx, sessionManager: { getSessionId: () => "other" } } as any, DEFAULT_CONFIG)).toBe(false);
    expect(approvals.has(event, ctx, { ...DEFAULT_CONFIG, mode: "deny" })).toBe(false);
    expect(approvals.has(event, ctx, DEFAULT_CONFIG)).toBe(false);
  });
  test("allow once, denial, cancellation and model allows never create grants", async () => {
    const { ctx, event, approvals } = fixture();
    for (const selected of ["Allow once", "Deny", undefined]) {
      ctx.ui.select = async () => selected;
      expect(await requestApproval(event as any, ctx, "title", "reason", { config: DEFAULT_CONFIG, approvals })).toBe(selected === "Allow once");
      expect(approvals.list(ctx, DEFAULT_CONFIG)).toHaveLength(0);
    }
    await handleToolCall(event as any, ctx, { config: DEFAULT_CONFIG, approvals, record: () => {}, review: async () => ({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "Allowed" }) });
    expect(approvals.list(ctx, DEFAULT_CONFIG)).toHaveLength(0);
  });
  test("saving a rule requires a scope preview and fails closed on write failure", async () => {
    const { ctx, event, approvals } = fixture();
    ctx.ui.select = async () => "Save command rule…";
    let preview = "";
    ctx.ui.confirm = async (_title: string, message: string) => { preview = message; return true; };
    let saved: any;
    expect(await requestApproval(event as any, ctx, "title", "reason", { config: DEFAULT_CONFIG, approvals, saveRule: (r) => { saved = r; } })).toBe(true);
    expect(saved).toMatchObject({ prefix: ["bun", "test"], cwd: ctx.cwd });
    expect(preview).toContain("additional trailing arguments");
    expect(await requestApproval(event as any, ctx, "title", "reason", { config: DEFAULT_CONFIG, approvals, saveRule: () => { throw new Error("read-only storage"); } })).toBe(false);
  });
  test("policy changes during a dialog cannot create stale approvals", async () => {
    const { ctx, event, approvals } = fixture();
    expect(await requestApproval(event as any, ctx, "title", "reason", { config: DEFAULT_CONFIG, approvals, currentConfig: () => ({ ...DEFAULT_CONFIG, mode: "deny" }) })).toBe(false);
    expect(approvals.list(ctx, DEFAULT_CONFIG)).toHaveLength(0);
  });
});
