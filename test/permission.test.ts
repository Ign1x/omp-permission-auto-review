import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, resetConfig, saveConfig } from "../src/config.ts";
import { handlePermissionCommand, registerPermissionCommand } from "../src/permission-command.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function paths() {
  const directory = mkdtempSync(join(tmpdir(), "omp-permission-test-"));
  directories.push(directory);
  const managed = join(directory, "managed.json");
  const basePath = join(directory, "config.json");
  const userPath = join(directory, "user.json");
  writeFileSync(managed, '{"model":"gateway/test","mode":"review"}\n');
  symlinkSync(managed, basePath);
  return { managed, basePath, userPath };
}

describe("permission settings", () => {
  test("writes a private override without replacing managed defaults", () => {
    const { managed, basePath, userPath } = paths();
    expect(loadConfig(basePath, userPath).model).toBe("gateway/test");
    saveConfig({ mode: "ask", toolRules: { bash: "deny" } }, basePath, userPath);
    expect(loadConfig(basePath, userPath)).toMatchObject({ model: "gateway/test", mode: "ask", toolRules: { bash: "deny" } });
    expect(readFileSync(managed, "utf8")).toBe('{"model":"gateway/test","mode":"review"}\n');
    expect(statSync(userPath).mode & 0o777).toBe(0o600);
    resetConfig(userPath);
    expect(loadConfig(basePath, userPath).mode).toBe("review");
  });

  test("rejects unknown keys, invalid rules, and prototype keys", () => {
    expect(() => parseConfig({ surprise: true })).toThrow("unknown config key");
    expect(() => parseConfig({ toolRules: { bash: "maybe" } })).toThrow("invalid tool rule");
    expect(() => parseConfig(JSON.parse('{"toolRules":{"__proto__":"allow"}}'))).toThrow("invalid tool rule");
    expect(() => parseConfig(JSON.parse('{"__proto__":{}}'))).toThrow("unknown config key");
  });

  test("command edits settings, shows paths, and resets overrides", async () => {
    const { basePath, userPath } = paths();
    const notices: Array<{ message: string; type: string }> = [];
    const ctx = {
      hasUI: true,
      models: { resolve: (value: string) => value === "gateway/test" ? {} : undefined, list: () => [] },
      ui: {
        confirm: async () => true,
        notify: (message: string, type: string) => notices.push({ message, type }),
      },
    } as any;
    const options = { basePath, userPath };
    await handlePermissionCommand("mode yolo", ctx, options);
    await handlePermissionCommand("fallback deny", ctx, options);
    await handlePermissionCommand("rule bash ask", ctx, options);
    await handlePermissionCommand("audit off", ctx, options);
    await handlePermissionCommand("timeout 18000", ctx, options);
    expect(loadConfig(basePath, userPath)).toMatchObject({
      mode: "yolo", failurePolicy: "deny", toolRules: { bash: "ask" }, auditLog: false, timeoutMs: 18000,
    });
    await handlePermissionCommand("rule remove bash", ctx, options);
    expect(loadConfig(basePath, userPath).toolRules).toEqual({});
    await handlePermissionCommand("show", ctx, options);
    expect(notices.at(-1)?.message).toContain("mode: yolo");
    await handlePermissionCommand("timeout 60000", ctx, options);
    expect(loadConfig(basePath, userPath).timeoutMs).toBe(60000);
    expect(notices.at(-1)?.message).toContain("extensionHandlers.toolCallTimeoutMs must be at least 65000 ms");
    expect(notices.at(-1)?.message).not.toContain("effective cap");
    await handlePermissionCommand("path", ctx, options);
    expect(notices.at(-1)?.message).toContain(userPath);
    await handlePermissionCommand("model unavailable", ctx, options);
    expect(notices.at(-1)?.type).toBe("error");
    await handlePermissionCommand("reset", ctx, options);
    expect(loadConfig(basePath, userPath)).toMatchObject({ mode: "review", model: "gateway/test" });
  });

  test("interactive menu persists selections and the command is registered", async () => {
    const { basePath, userPath } = paths();
    let registered: any;
    registerPermissionCommand({ registerCommand: (name: string, options: unknown) => { registered = { name, options }; } } as any);
    expect(registered.name).toBe("permission");
    const choices = ["Mode", "ask", "Done"];
    const ctx = {
      hasUI: true,
      models: { list: () => [], resolve: () => ({}) },
      ui: {
        select: async () => choices.shift(),
        notify: () => {},
        confirm: async () => true,
      },
    } as any;
    await handlePermissionCommand("", ctx, { basePath, userPath });
    expect(loadConfig(basePath, userPath).mode).toBe("ask");
    expect(registered.options.getArgumentCompletions("mo")[0].value).toBe("mode");
  });

  test("interactive menu edits an existing tool rule", async () => {
    const { basePath, userPath } = paths();
    saveConfig({ toolRules: { bash: "deny" } }, basePath, userPath);
    const choices = ["Tool rules", "bash: deny", "allow", "Done"];
    const ctx = {
      hasUI: true,
      models: { list: () => [], resolve: () => ({}) },
      ui: {
        select: async () => choices.shift(),
        notify: () => {},
        confirm: async () => true,
      },
    } as any;
    await handlePermissionCommand("", ctx, { basePath, userPath });
    expect(loadConfig(basePath, userPath).toolRules).toEqual({ bash: "allow" });
  });
});
