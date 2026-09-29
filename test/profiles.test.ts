import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, loadConfig, loadEffectiveConfig, configSources, clearSessionConfig } from "../src/config.ts";
import { PROFILES } from "../src/profiles.ts";
import { evaluatePolicy } from "../src/policy.ts";
import { handlePermissionCommand, registerPermissionCommand } from "../src/permission-command.ts";
import extension, { handleToolCall } from "../src/index.ts";

const fixtures: Array<{ dir: string; ctx: any }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { clearSessionConfig(f.ctx); rmSync(f.dir, { recursive: true, force: true }); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-profiles-"));
  const cwd = join(dir, "workspace"); mkdirSync(cwd); writeFileSync(join(cwd, "file.txt"), "fixture");
  const messages: string[] = [];
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => dir }, models: { resolve: () => ({ id: "test", provider: "fixture" }) },
    ui: { notify: (s: string) => messages.push(s), confirm: async () => true },
  } as any;
  fixtures.push({ dir, ctx });
  return { dir, cwd, ctx, messages, paths: { basePath: join(dir, "config.json"), userPath: join(dir, "user.json") } };
}
describe("profiles and configuration layers", () => {
  test("profiles express distinct behavior without silently changing legacy defaults", () => {
    const { cwd } = fixture();
    const legacy = parseConfig({ timeoutMs: 120000 });
    expect(legacy.profile).toBe("custom"); expect(legacy.reviewTimeoutMs).toBe(20000);
    const check = (id: string, toolName: string, input: unknown) => evaluatePolicy({ toolName, input }, cwd, parseConfig(PROFILES.find((p) => p.id === id)!.changes)).action;
    expect(check("inspect", "read", { path: "file.txt" })).toBe("allow");
    expect(check("inspect", "write", { path: "file.txt", content: "new" })).toBe("ask");
    expect(check("workspace", "write", { path: "new/file.txt", content: "new" })).toBe("allow");
    expect(check("workspace", "write", { path: "../outside", content: "new" })).toBe("review");
    expect(check("workspace", "edit", { input: "opaque patch" })).toBe("review");
    expect(check("full-access", "bash", { command: "custom-task" })).toBe("allow");
    expect(check("custom", "write", { path: "file.txt", content: "new" })).toBe("review");
    expect(() => parseConfig({ reviewer: "anything" })).toThrow();
  });
  test("session overrides are isolated, show provenance and leave files untouched", async () => {
    const { ctx, paths, messages } = fixture();
    writeFileSync(paths.basePath, '{"timeoutMs":60000,"model":"fixture/reviewer"}\n');
    const original = readFileSync(paths.basePath, "utf8");
    await handlePermissionCommand("profile inspect", ctx, paths);
    const user = readFileSync(paths.userPath, "utf8");
    await handlePermissionCommand("scope session", ctx, paths);
    await handlePermissionCommand("profile workspace", ctx, paths);
    await handlePermissionCommand("budget 3", ctx, paths);
    expect(loadEffectiveConfig(ctx, paths.basePath, paths.userPath)).toMatchObject({ profile: "workspace", reviewTimeoutMs: 3000 });
    expect(loadConfig(paths.basePath, paths.userPath).profile).toBe("inspect");
    expect(readFileSync(paths.basePath, "utf8")).toBe(original);
    expect(readFileSync(paths.userPath, "utf8")).toBe(user);
    expect(configSources(ctx, paths.basePath, paths.userPath)).toMatchObject({ model: "managed", profile: "session", maxRetries: "default" });
    await handlePermissionCommand("session-reset", ctx, paths);
    expect(loadEffectiveConfig(ctx, paths.basePath, paths.userPath).profile).toBe("inspect");
    await handlePermissionCommand("sources", ctx, paths);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({ profile: "user", model: "managed" });
  });
  test("menu separates presets from advanced settings and exposes completion", async () => {
    const { ctx, paths } = fixture();
    const choices = ["Permission profile", "Inspect project", "Advanced", "Retries", "Done"];
    const menus: string[][] = [];
    ctx.ui.select = async (_title: string, items: Array<string | { label: string }>) => {
      const labels = items.map((i) => typeof i === "string" ? i : i.label);
      menus.push(labels);
      const next = choices.shift();
      expect(labels).toContain(next!);
      return next;
    };
    ctx.ui.input = async () => "0";
    await handlePermissionCommand("", ctx, paths);
    expect(menus[0]).not.toContain("Retries");
    expect(loadConfig(paths.basePath, paths.userPath)).toMatchObject({ profile: "inspect", maxRetries: 0 });
    let registered: any;
    registerPermissionCommand({ registerCommand: (_name: string, options: any) => { registered = options; } } as any);
    for (const cmd of ["budget", "manual", "cancel", "history", "doctor", "approvals", "sources"])
      expect(registered.getArgumentCompletions(cmd)[0].value).toBe(cmd);
    expect(registered.getArgumentCompletions("profile w")[0].value).toBe("profile workspace");
  });
  test("one OMP interceptor and both review shortcuts register successfully", () => {
    const events: string[] = [], shortcuts: string[] = [];
    extension({ registerCommand: () => {}, registerShortcut: (key: string) => shortcuts.push(key), on: (event: string) => events.push(event) } as any);
    expect(events.filter((e) => e === "tool_call")).toHaveLength(1);
    expect(shortcuts).toEqual(["ctrl+alt+a", "ctrl+alt+x"]);
    expect(events).toContain("session_shutdown");
  });
  test("unavailable approval UI blocks without opening a second fallback dialog", async () => {
    const { ctx } = fixture();
    let prompts = 0;
    ctx.ui.confirm = async () => { prompts++; throw new Error("dialog closed"); };
    expect(await handleToolCall({ type: "tool_call", toolName: "bash", toolCallId: "ui", input: { command: "test" } } as any, ctx, {
      config: parseConfig({ mode: "ask" }), record: () => {},
    })).toMatchObject({ block: true });
    expect(prompts).toBe(1);
  });
  test("locally allowed reads do not load conversation evidence", async () => {
    const { ctx } = fixture();
    ctx.sessionManager.getBranch = () => { throw new Error("conversation must not be loaded for local policy"); };
    expect(await handleToolCall({ type: "tool_call", toolName: "read", toolCallId: "read", input: { path: "file.txt" } } as any, ctx, {
      config: parseConfig({}), record: () => {}, review: async () => { throw new Error("review must not run"); },
    })).toBeUndefined();
  });
});
