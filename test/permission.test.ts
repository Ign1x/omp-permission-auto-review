import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, resetConfig, saveConfig } from "../src/config.ts";
import { handlePermissionCommand, registerPermissionCommand } from "../src/permission-command.ts";
import { parseTimeoutSeconds } from "../src/timing.ts";

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
    for (const maxRetries of [-1, 1.5, 6, "2"]) expect(() => parseConfig({ maxRetries })).toThrow("maxRetries");
    expect(() => parseConfig({ reasoning: "off" })).toThrow("reasoning");
    expect(parseConfig({}).baselineRules).toBe(true);
    for (const baselineRules of ["on", null, 1, {}]) expect(() => parseConfig({ baselineRules })).toThrow("baselineRules");
    expect(parseConfig({ timeoutMs: 120000 })).toMatchObject({ timeoutMs: 120000, maxRetries: 2, reasoning: "low" });
  });

  test("timeout accepts seconds and rejects old millisecond command values", () => {
    expect(parseTimeoutSeconds("60")).toBe(60000);
    expect(parseTimeoutSeconds("60s")).toBe(60000);
    expect(parseTimeoutSeconds("0.5s")).toBe(500);
    for (const value of ["60000", "60ms", "0", "-1", "Infinity", "0.0001", "301"]) {
      expect(() => parseTimeoutSeconds(value)).toThrow("seconds");
    }
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
    await handlePermissionCommand("timeout 18", ctx, options);
    expect(loadConfig(basePath, userPath)).toMatchObject({
      mode: "yolo", failurePolicy: "deny", toolRules: { bash: "ask" }, auditLog: false, timeoutMs: 18000,
    });
    await handlePermissionCommand("rule remove bash", ctx, options);
    expect(loadConfig(basePath, userPath).toolRules).toEqual({});
    await handlePermissionCommand("show", ctx, options);
    expect(notices.at(-1)?.message).toContain("mode: yolo");
    await handlePermissionCommand("timeout 60s", ctx, options);
    expect(loadConfig(basePath, userPath).timeoutMs).toBe(60000);
    expect(notices.at(-1)?.message).toContain("OMP handler budget: at least 25 seconds");
    expect(notices.at(-1)?.message).not.toContain("effective cap");
    expect(notices.at(-1)?.message).toContain("thinking: low");
    await handlePermissionCommand("retries 0", ctx, options);
    expect(loadConfig(basePath, userPath).maxRetries).toBe(0);
    await handlePermissionCommand("thinking high", ctx, options);
    expect(loadConfig(basePath, userPath).reasoning).toBe("high");
    await handlePermissionCommand("retries 6", ctx, options);
    expect(notices.at(-1)?.type).toBe("error");
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
    expect(registered.options.getArgumentCompletions("baseline l")[0].value).toBe("baseline list");
  });

  test("baseline settings support commands, listing, menu and reset", async () => {
    const options = paths();
    saveConfig({ baselineRules: false }, options.basePath, options.userPath);
    const notices: string[] = [];
    const choices = ["Baseline rules", "on", "Baseline rules", "list", "Done"];
    const ctx = { hasUI: true, ui: {
      select: async () => choices.shift(),
      confirm: async () => true,
      notify: (message: string) => notices.push(message),
    } } as any;
    await handlePermissionCommand("", ctx, options);
    expect(loadConfig(options.basePath, options.userPath).baselineRules).toBe(true);
    expect(notices.at(-1)).toContain("local.ls: ls");
    await handlePermissionCommand("baseline off", ctx, options);
    expect(loadConfig(options.basePath, options.userPath).baselineRules).toBe(false);
    expect(notices.at(-1)).toContain("baseline rules: off");
    await handlePermissionCommand("baseline invalid", ctx, options);
    expect(notices.at(-1)).toContain("baseline must be on, off, or list");
    expect(loadConfig(options.basePath, options.userPath).baselineRules).toBe(false);
    await handlePermissionCommand("reset", ctx, options);
    expect(loadConfig(options.basePath, options.userPath).baselineRules).toBe(true);
    expect(readFileSync(options.managed, "utf8")).toBe('{"model":"gateway/test","mode":"review"}\n');
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

  test("interactive timeout input and help show units and expose retries", async () => {
    const options = paths();
    const choices = ["Timeout (seconds)", "Retries", "Thinking", "low", "Done"];
    const inputs = ["45", "2"];
    const fields: string[] = [];
    const notices: string[] = [];
    const ctx = { hasUI: true, ui: {
      select: async () => choices.shift(),
      input: async (title: string, placeholder: string) => { fields.push(`${title}: ${placeholder}`); return inputs.shift(); },
      notify: (message: string) => notices.push(message),
    } } as any;
    await handlePermissionCommand("", ctx, options);
    expect(loadConfig(options.basePath, options.userPath)).toMatchObject({ timeoutMs: 45000, maxRetries: 2, reasoning: "low" });
    expect(fields[0]).toContain("Timeout per attempt (seconds)");
    expect(fields[0]).toContain("60s");
    expect(fields[0]).not.toContain("milliseconds");
    expect(fields[1]).toContain("3 attempts total");
    await handlePermissionCommand("help", ctx, options);
    expect(notices.at(-1)).toContain("timeout <seconds>");
    expect(notices.at(-1)).toContain("retries <0-5>");
  });
});
