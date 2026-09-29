import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGuardianAssessment, mayAutoApprove, REVIEWER_SYSTEM_PROMPT } from "../src/review.ts";
import { inspectPath } from "../src/review-inspection.ts";
import { modelReview, handleToolCall } from "../src/index.ts";
import { parseConfig } from "../src/config.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-guardian-")); dirs.push(dir);
  const cwd = join(dir, "project"); mkdirSync(cwd);
  writeFileSync(join(cwd, "helper.ts"), "export const resize = (w, h) => [h, w];\n");
  const branch: any[] = [{ type: "message", message: { role: "user", content: "Fix resize and preserve unrelated files." } }];
  const ctx = { cwd, hasUI: true, agent: { kind: "main" }, model: { provider: "fixture", id: "reviewer" },
    sessionManager: { getBranch: () => branch }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    ui: { notify: () => {}, confirm: async () => { throw new Error("unexpected manual prompt"); } },
  } as any;
  const event = { type: "tool_call", toolName: "write", toolCallId: "pending", input: { path: "helper.ts", content: "export const resize = (w, h) => [w, h];\n" } } as any;
  return { dir, cwd, ctx, event, branch };
}

describe("Codex Guardian adaptation", () => {
  test("short outcomes and JSON wrapper recovery follow Codex's contract", () => {
    expect(parseGuardianAssessment('{"outcome":"allow"}')).toMatchObject({ outcome: "allow", risk_level: "low", user_authorization: "unknown" });
    expect(parseGuardianAssessment('Result: {"outcome":"deny"}\n')).toMatchObject({ outcome: "deny", risk_level: "high" });
    expect(parseGuardianAssessment('```json\n{"outcome":"allow"}\n```').outcome).toBe("allow");
    for (const invalid of ['{"outcome":"defer"}', '{"outcome":"allow","extra":true}', '{"outcome":"allow","risk_level":"critical"}', '{"outcome":"allow"} {"outcome":"deny"}', 'allowed']) expect(() => parseGuardianAssessment(invalid)).toThrow();
    expect(mayAutoApprove(parseGuardianAssessment('{"outcome":"allow","risk_level":"high","user_authorization":"low"}'))).toBe(false);
  });
  test("composes upstream policy with truthful OMP environment and complete placeholders", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('necessary implementation of that user-requested operation');
    expect(REVIEWER_SYSTEM_PROMPT).toContain('risk_level = "medium"` -> `allow`');
    expect(REVIEWER_SYSTEM_PROMPT).toContain("does not\ninstall or guarantee an OS sandbox");
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain("{{");
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain("The coding-agent is running in a sandbox");
  });
  test("inspection gathers local facts without changing files", async () => {
    const { cwd } = fixture();
    expect(JSON.parse(await inspectPath({ path: "missing.ts", operation: "stat" }, cwd, signal()))).toMatchObject({ exists: false });
    expect(JSON.parse(await inspectPath({ path: ".", operation: "list" }, cwd, signal())).entries).toContain("helper.ts");
    expect(JSON.parse(await inspectPath({ path: "helper.ts", operation: "read" }, cwd, signal())).content).toContain("[h, w]");
    expect(readFileSync(join(cwd, "helper.ts"), "utf8")).toContain("[h, w]");
  });
  test("inspection rejects escapes, credentials, writes and unsupported arguments", async () => {
    const { cwd, dir } = fixture();
    writeFileSync(join(dir, "outside"), "private"); symlinkSync(join(dir, "outside"), join(cwd, "escape"));
    writeFileSync(join(cwd, ".env"), "SECRET=example");
    for (const input of [
      { path: "../outside", operation: "read" }, { path: "escape", operation: "read" },
      { path: ".env", operation: "read" }, { path: "helper.ts", operation: "write" },
      { path: "helper.ts", operation: "read", command: "touch marker" },
      { path: "helper.ts", operation: "read", offset: -1 }, { path: "/dev/zero", operation: "read" },
    ]) expect(JSON.parse(await inspectPath(input, cwd, signal())).error).toBeDefined();
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(inspectPath({ path: "helper.ts", operation: "read" }, cwd, controller.signal)).rejects.toThrow("cancelled");
  });
  test("reviewer can inspect B and decide without calling OMP's action tools or a user dialog", async () => {
    const { ctx, event } = fixture(); let calls = 0;
    const result = await modelReview(event, ctx, parseConfig({}), (async (_model: any, context: any) => {
      expect(context.tools.map((t: any) => t.name)).toEqual(["inspect_path"]);
      if (++calls === 1) return { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "probe", name: "inspect_path", arguments: { path: "helper.ts", operation: "read" } }] };
      expect(context.messages.at(-1).role).toBe("toolResult");
      expect(context.messages.at(-1).content[0].text).toContain("[h, w]");
      return { stopReason: "stop", content: [{ type: "text", text: '{"outcome":"allow"}' }] };
    }) as any);
    expect(result.outcome).toBe("allow"); expect(calls).toBe(2);
  });
  test("unsupported inspection tools never execute and the total probe budget is finite", async () => {
    const { ctx, event } = fixture(); let calls = 0;
    await expect(modelReview(event, ctx, parseConfig({ maxRetries: 0 }), (async (_m: any, context: any) => {
      if (++calls > 1) expect(context.messages.at(-1).content[0].text).toContain("commands and writes are not permitted");
      return { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `probe-${calls}`, name: "bash", arguments: { command: "touch marker" } }] };
    }) as any)).rejects.toThrow("inspection limit reached");
    expect(calls).toBe(5);
  });
  test("changed user authorization stops the investigation before another provider request", async () => {
    const { ctx, event, branch } = fixture(); let calls = 0;
    await expect(modelReview(event, ctx, parseConfig({ maxRetries: 0 }), (async () => {
      calls++;
      branch.push({ type: "message", message: { role: "user", content: "Stop; do not run anything." } });
      return { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "probe", name: "inspect_path", arguments: { path: "helper.ts", operation: "read" } }] };
    }) as any)).rejects.toThrow("User instructions or permission settings changed");
    expect(calls).toBe(1);
  });
  test("default review failures return to the coding agent rather than a selection dialog", async () => {
    const { ctx, event } = fixture();
    expect(parseConfig({}).failurePolicy).toBe("deny");
    const result = await handleToolCall(event, ctx, { config: parseConfig({}), record: () => {}, review: async () => { throw new Error("offline"); } });
    expect(result).toMatchObject({ block: true, reason: "Automatic review unavailable: offline" });
  });
});
