import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchBaselineRule } from "../src/baseline-rules.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { handleToolCall } from "../src/index.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "omp-read-test-"));
  directories.push(parent);
  const cwd = join(parent, "workspace");
  mkdirSync(cwd);
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "main.ts"), "const answer = 42;\n");
  writeFileSync(join(cwd, "中文 (notes).md"), "notes\n");
  writeFileSync(join(parent, "outside.txt"), "outside\n");
  const match = (path: string) => matchBaselineRule("read", { path }, cwd);
  return { parent, cwd, match };
}

describe("workspace read fast path", () => {
  test("allows relative/absolute existing files, directories and OMP text selectors", () => {
    const { cwd, match } = fixture();
    for (const path of ["src/main.ts", "./src/main.ts", join(cwd, "src/main.ts"), ".", "src", "中文 (notes).md",
      "src/main.ts:1", "src/main.ts:1-10", "src/main.ts:2+3", "src/main.ts:2-", "src/main.ts:-10",
      "src/main.ts:raw", "src/main.ts:raw:1-10", "src/main.ts:1-10:raw", "src/main.ts:1-2,4-6", "src:1-10",
    ]) expect(match(path)?.id).toBe("workspace.read");
  });

  test("resolves symlinked workspaces and allows only targets remaining inside them", () => {
    const { cwd, parent, match } = fixture();
    symlinkSync(join(cwd, "src"), join(cwd, "linked"));
    symlinkSync(join(parent, "outside.txt"), join(cwd, "escape"));
    symlinkSync(parent, join(cwd, "outside-dir"));
    symlinkSync(cwd, join(parent, "workspace-alias"));
    expect(match("linked/main.ts")?.id).toBe("workspace.read");
    expect(matchBaselineRule("read", { path: "src/main.ts" }, join(parent, "workspace-alias"))?.id).toBe("workspace.read");
    for (const path of ["escape", "escape:raw", "outside-dir/outside.txt", "../outside.txt", join(parent, "outside.txt")]) {
      expect(match(path)).toBeUndefined();
    }
    mkdirSync(join(parent, "workspace-other"));
    writeFileSync(join(parent, "workspace-other", "file.txt"), "outside");
    expect(match(join(parent, "workspace-other", "file.txt"))).toBeUndefined();
  });

  test("never strips a selector-looking literal filename or dangling symlink", () => {
    const { cwd, parent, match } = fixture();
    symlinkSync(join(parent, "outside.txt"), join(cwd, "src/main.ts:raw"));
    symlinkSync(join(parent, "missing.txt"), join(cwd, "src/main.ts:1-10"));
    expect(match("src/main.ts:raw")).toBeUndefined();
    expect(match("src/main.ts:1-10")).toBeUndefined();
  });

  test("does not match URL, remote, multi-file, ambiguous, special or unknown inputs", () => {
    const { cwd, match } = fixture();
    for (const path of ["", "missing.ts", "missing.ts:1-10", "https://example.com", `file://${cwd}/src/main.ts`,
      "local://src/main.ts", "artifact://1", "ssh://host/file", "//server/share", "~/src/main.ts", "@/tmp/file",
      "src/*.ts", "src/main.ts;../outside.txt", "src/main.ts,../outside.txt", "src/main.ts ../outside.txt",
      "src/main.ts? q", "src/main.ts?q=describe", "src/main.ts:img", "src/main.ts:table", "src/main.ts:0",
      "src/main.ts:raw:raw", "src/main.ts\n", "src/main.ts\0", "src\\main.ts", "a".repeat(4097),
    ]) expect(match(path)).toBeUndefined();
    for (const input of [null, [], {}, { path: 1 }, { path: "src/main.ts", future: true }, { path: "src/main.ts", offset: 1 }]) {
      expect(matchBaselineRule("read", input, cwd)).toBeUndefined();
    }
    expect(matchBaselineRule("custom_read", { path: "src/main.ts" }, cwd)).toBeUndefined();
    expect(matchBaselineRule("read", { path: "src/main.ts" }, "s3://bucket")).toBeUndefined();
    // /dev/null exists but is a device, not an ordinary file.
    if (process.platform !== "win32") expect(matchBaselineRule("read", { path: "/dev/null" }, "/dev")).toBeUndefined();
  });

  test("workspace reads make zero reviewer requests, require no evidence, and report their source", async () => {
    const { cwd } = fixture();
    let reviews = 0;
    let prompts = 0;
    const statuses: string[] = [];
    const records: string[] = [];
    const ctx = { cwd, hasUI: true, ui: {
      confirm: async () => { prompts++; return false; },
      setStatus: (_key: string, value: string) => statuses.push(value),
    } } as any;
    const event = { type: "tool_call", toolName: "read", toolCallId: "read-test", input: { path: "src/main.ts:1-10" } } as const;
    const options = {
      config: DEFAULT_CONFIG,
      record: (_event: unknown, outcome: string, detail?: string) => records.push(`${outcome}:${detail}`),
      review: async () => { reviews++; throw new Error("review should not run"); },
    };
    expect(await handleToolCall(event as any, ctx, options)).toBeUndefined();
    expect(await handleToolCall(event as any, { ...ctx, hasUI: false }, options)).toBeUndefined();
    expect({ reviews, prompts }).toEqual({ reviews: 0, prompts: 0 });
    expect(records).toEqual(["baseline_allow:workspace.read", "baseline_allow:workspace.read"]);
  });

  test("explicit policies and disabling baseline rules retain precedence", async () => {
    const { cwd } = fixture();
    const event = { type: "tool_call", toolName: "read", toolCallId: "read-test", input: { path: "src/main.ts" } } as const;
    for (const [change, expectedReviews, expectedPrompts] of [
      [{ baselineRules: false }, 1, 0], [{ toolRules: { read: "review" } }, 1, 0],
      [{ toolRules: { read: "deny" } }, 0, 0], [{ toolRules: { read: "ask" } }, 0, 1],
      [{ mode: "ask" }, 0, 1], [{ mode: "deny" }, 0, 0],
    ] as Array<[Partial<Config>, number, number]>) {
      let reviews = 0;
      let prompts = 0;
      const ctx = { cwd, hasUI: true, ui: { confirm: async () => { prompts++; return false; } } } as any;
      expect(await handleToolCall(event as any, ctx, {
        config: { ...DEFAULT_CONFIG, ...change }, record: () => {},
        review: async () => { reviews++; return { outcome: "deny", risk_level: "low", user_authorization: "unknown", rationale: "fixture" }; },
      })).toMatchObject({ block: true });
      expect({ reviews, prompts }).toEqual({ reviews: expectedReviews, prompts: expectedPrompts });
    }
  });
});
