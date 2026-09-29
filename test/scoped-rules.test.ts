import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { evaluatePolicy } from "../src/policy.ts";
import { parseCommands } from "../src/command-parser.ts";
import { handlePermissionCommand } from "../src/permission-command.ts";
import type { ScopedRule } from "../src/scoped-rules.ts";

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-scoped-")); dirs.push(dir);
  const cwd = join(dir, "project"); mkdirSync(cwd); mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.ts"), "hello");
  return { dir, cwd };
}
describe("scoped permissions", () => {
  test("requires every compound segment and applies strongest matching policy", () => {
    const { cwd } = fixture();
    const rules: ScopedRule[] = [
      { id: "test", kind: "command", cwd, prefix: ["bun", "test"], decision: "allow" },
      { id: "status", kind: "command", cwd, prefix: ["git", "status"], decision: "allow" },
      { id: "no-watch", kind: "command", cwd, prefix: ["bun", "test", "--watch"], decision: "deny" },
    ];
    const config = parseConfig({ scopedRules: rules });
    const check = (command: string, input = {}) => evaluatePolicy({ toolName: "bash", input: { command, ...input } }, cwd, config);
    expect(check("git status && bun test test").action).toBe("allow");
    expect(check("git status | bun test").action).toBe("allow");
    expect(check("git status && curl example.com").action).toBe("review");
    expect(check("bun test --watch").action).toBe("deny");
    expect(check("bun testing").action).toBe("review");
    expect(check("bun test", { env: {} }).action).toBe("review");
    expect(check("bun test", { cwd: "/" }).action).toBe("review");
    expect(evaluatePolicy({ toolName: "bash", input: { command: "bun test --watch" } }, cwd,
      parseConfig({ mode: "yolo", toolRules: { bash: "allow" }, scopedRules: rules })).action).toBe("deny");
  });
  test.each(["git status &&", "git status & bun test", "git status;", "A=x git status", "git status > out", "git status $(id)", "git status\nbun test", "cd /tmp && bun test", "git status '*.ts'", "git status 'a;b'", "git status ||| bun test"])("unsupported shell syntax does not match: %s", (cmd) => {
    expect(parseCommands(cmd)).toBeUndefined();
  });
  test("path scopes support read and write without symlink or sibling escapes", () => {
    const { dir, cwd } = fixture();
    symlinkSync(dir, join(cwd, "src/outside"));
    symlinkSync(join(dir, "missing"), join(cwd, "src/dangling"));
    const config = parseConfig({ baselineRules: false, scopedRules: [
      { id: "read", kind: "path", root: join(cwd, "src"), tool: "read", decision: "allow" },
      { id: "write", kind: "path", root: join(cwd, "src"), tool: "write", decision: "allow" },
    ] });
    const check = (toolName: string, input: unknown) => evaluatePolicy({ toolName, input }, cwd, config).action;
    expect(check("read", { path: "src/a.ts:1-2" })).toBe("allow");
    expect(check("write", { path: "src/new/f.ts", content: "data" })).toBe("allow");
    for (const path of ["src/outside/secret", "src/dangling", "src/dangling/new", "src/../../escape", "src-other/file", "local://src/a.ts"])
      expect(check("write", { path, content: "data" })).toBe("review");
    expect(check("write", { path: "src/a.ts", content: "data", extra: true })).toBe("review");
    expect(check("edit", { path: "src/a.ts", input: "opaque patch" })).toBe("review");
  });
  test("rejects broad interpreter permissions and invalid rule configurations", () => {
    const { cwd } = fixture();
    for (const prefix of [["bash", "-c"], ["python3", "-c"], ["git"], ["bun", "-e"], ["git", "status;id"]])
      expect(() => parseConfig({ scopedRules: [{ id: "bad", kind: "command", decision: "allow", cwd, prefix }] })).toThrow();
    expect(() => parseConfig({ scopedRules: [{ id: "bad", kind: "path", tool: "read", root: ".", decision: "allow" }] })).toThrow();
  });
  test("commands add, explain and remove rules without executing tools", async () => {
    const { cwd, dir } = fixture();
    const messages: string[] = [];
    const ctx = { cwd, hasUI: true, ui: { notify: (s: string) => messages.push(s), confirm: async () => true } } as any;
    const paths = { basePath: join(dir, "config.json") };
    const rule = { id: "test", kind: "command", cwd, prefix: ["bun", "test"], decision: "allow" };
    await handlePermissionCommand(`scoped add ${JSON.stringify(rule)}`, ctx, paths);
    await handlePermissionCommand('explain bash {"command":"bun test"}', ctx, paths);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({ action: "allow", ruleId: "test" });
    await handlePermissionCommand("scoped remove test", ctx, paths);
    await handlePermissionCommand('explain bash {"command":"bun test"}', ctx, paths);
    expect(JSON.parse(messages.at(-1)!)).toMatchObject({ action: "review" });
  });
});
