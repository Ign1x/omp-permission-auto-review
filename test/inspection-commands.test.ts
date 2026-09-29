import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { matchBaselineRule } from "../src/baseline-rules.ts";
import { parseConfig } from "../src/config.ts";
import { evaluatePolicy } from "../src/policy.ts";
import { handleToolCall } from "../src/index.ts";
import { parseCommandChain, parseCommands } from "../src/command-parser.ts";

let dir: string, cwd: string, sub: string;
const envKeys = ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER", "LESS"];
let saved: Record<string, string | undefined>;
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const match = (command: string, input = {}) => matchBaselineRule("bash", { command, ...input }, cwd);
const screenshot = () => `cd ${sub} && git diff CMakeLists.txt clean.sh compile.sh src/resize_image.cpp output/bilateral.png | head -80`;
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  envKeys.forEach((key) => { delete process.env[key]; });
  process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  dir = mkdtempSync(join(tmpdir(), "omp-inspection-"));
  cwd = join(dir, "project"); sub = join(cwd, "hw2"); mkdirSync(sub, { recursive: true });
  git("init", "--quiet");
  writeFileSync(join(sub, "CMakeLists.txt"), "old\n");
  git("add", ".");
  writeFileSync(join(sub, "CMakeLists.txt"), "new\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  envKeys.forEach((key) => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
});

describe("local inspection", () => {
  test("screenshot command skips model, authentication and approval entirely", async () => {
    const event = { type: "tool_call", toolName: "bash", toolCallId: "screenshot", input: { command: screenshot() } };
    expect(match(screenshot())?.id).toBe("workspace.inspect");
    const records: unknown[] = [];
    const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => { throw new Error("must not request evidence"); } },
      ui: { select: () => { throw new Error("must not prompt"); } } } as any;
    expect(await handleToolCall(event as any, ctx, {
      config: parseConfig({}), record: (...args) => records.push(args),
      review: async () => { throw new Error("must not review"); },
    })).toBeUndefined();
    expect(records[0]).toEqual([event, "baseline_allow", "workspace.inspect"]);
  });

  test.each([
    "git status", "git status --porcelain=v1", "git diff", "git diff --stat", "git diff --cached --name-only",
    "git diff --no-ext-diff --no-textconv -- hw2/CMakeLists.txt", "git diff -U20 | head -n 80",
    "git diff | tail -20", "git diff | sed -n '1,80p'", "git -C hw2 diff | head -80",
    "git status && git diff | head -80", "ls -la | head -20", "pwd && ls",
  ])("covers ordinary inspection: %s", (command) => {
    expect(match(command)?.id).toBe("workspace.inspect");
  });

  test.each([
    "git diff --output=result", "git diff --output result", "git diff --ext-diff", "git diff --textconv",
    "git -c diff.external=payload diff", "git diff > result", "git diff | sh", "git diff; touch result",
    "git diff | head -80; rm file", "git diff $(id)", "git diff --no-index /tmp/a /tmp/b",
    "git status --future-option", "git diff | head private.key", "git diff | sed -n '1e id'",
    "git diff | tail -f", "git diff && head -80", "git reset --hard", "git clean -fd", "git checkout -- hw2",
    "git diff | head -80 &", "git diff\npwd", "git diff || sh", "cd hw2 && git diff",
  ])("keeps unsupported effects on the reviewer path: %s", (command) => {
    expect(match(command)).toBeUndefined();
  });

  test("directory changes stay inside the workspace and require success", () => {
    mkdirSync(join(dir, "outside")); symlinkSync(join(dir, "outside"), join(cwd, "escape"));
    for (const command of [
      `cd ${sub}; git diff`, `cd ${sub} || git diff`, `cd ${sub} | git diff`,
      `cd ${sub} && git diff; pwd`, `cd ${sub} && git diff || pwd`,
      `cd ${sub} && cd /tmp && git diff`, `cd ${cwd}/missing && git diff`,
      `cd ${cwd}/escape && git diff`, `git -C ${dir}/outside diff`,
    ]) expect(match(command)).toBeUndefined();
    expect(match("git diff", { cwd: sub })?.id).toBe("workspace.inspect");
    expect(match("git diff", { cwd: join(dir, "outside") })).toBeUndefined();
    expect(match(screenshot(), { env: {} })).toBeUndefined();
    expect(match(screenshot(), { pty: true })).toBeUndefined();
  });

  test.each(["diff.external", "diff.custom.command", "diff.custom.textconv", "filter.custom.clean", "filter.custom.process", "core.fsmonitor", "core.pager"])("configured helper stays on review path without executing it: %s", (key) => {
    const marker = join(dir, "executed");
    git("config", key, `touch ${marker}`);
    expect(match("git diff")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("helper config changes, includes and inherited overrides are rechecked", () => {
    expect(match(screenshot())).toBeDefined();
    const included = join(dir, "included.config");
    writeFileSync(included, "[diff \"custom\"]\ntextconv = payload\n");
    git("config", "include.path", included);
    expect(match(screenshot())).toBeUndefined();
    git("config", "--unset", "include.path");
    expect(match(screenshot())).toBeDefined();
    process.env.GIT_EXTERNAL_DIFF = "payload";
    expect(match(screenshot())).toBeUndefined();
    delete process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "diff.external"; process.env.GIT_CONFIG_VALUE_0 = "payload";
    try { expect(match(screenshot())).toBeUndefined(); }
    finally { delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; }
  });

  test("submodules and partial-clone fetches need review", () => {
    git("config", "remote.origin.promisor", "true");
    expect(match(screenshot())).toBeUndefined();
    git("config", "--unset", "remote.origin.promisor");
    git("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,submodule");
    expect(match(screenshot())).toBeUndefined();
  });

  test("normal pagers are accepted; a pipeline does not start a custom pager", () => {
    process.env.GIT_PAGER = "cat"; process.env.PAGER = "less";
    expect(match("git diff")).toBeDefined();
    git("config", "core.pager", "payload");
    expect(match(screenshot())).toBeDefined();
    delete process.env.GIT_PAGER;
    expect(match("git diff")).toBeUndefined();
  });

  test("explicit tool and scoped restrictions take priority, including after cd", () => {
    const event = { toolName: "bash", input: { command: screenshot() } };
    for (const action of ["deny", "ask", "review"] as const) {
      expect(evaluatePolicy(event, cwd, parseConfig({ toolRules: { bash: action } })).action).toBe(action);
    }
    expect(evaluatePolicy(event, cwd, parseConfig({ baselineRules: false })).action).toBe("review");
    for (const decision of ["deny", "ask"] as const) {
      expect(evaluatePolicy(event, cwd, parseConfig({ scopedRules: [{ id: "diff", kind: "command", cwd: sub, prefix: ["git", "diff"], decision }] })).action).toBe(decision);
    }
    expect(parseCommands(screenshot())).toBeUndefined(); // No widened persistent prefix grants.
    expect(parseCommandChain(screenshot())?.operators).toEqual(["&&", "|"]);
  });
});
