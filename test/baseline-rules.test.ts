import { describe, expect, test } from "bun:test";
import { BASELINE_RULES, matchBaselineRule } from "../src/baseline-rules.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { handleToolCall } from "../src/index.ts";

const match = (command: string) => matchBaselineRule("bash", { command }, "/work");

describe("baseline command library", () => {
  test.each([
    ["pwd", "local.pwd"], ["  pwd\t-P  ", "local.pwd"],
    ["ls", "local.ls"], ["ls -lah src test", "local.ls"],
    ["ls --all --color=never 'my files'", "local.ls"], ["ls -- '-R'", "local.ls"],
    ['ls "中文目录"', "local.ls"], ["ls src/ -l", "local.ls"],
    ["stat -Lt README.md", "local.stat"], ["stat --file-system /tmp", "local.stat"],
    ["uname -sm", "local.uname"], ["uname --all", "local.uname"],
    ["whoami", "local.whoami"], ["id -un", "local.id"],
    ["basename -- /work/file.ts", "local.basename"], ['dirname "my files/file.ts"', "local.dirname"],
  ])("matches the complete literal command %s", (command, id) => {
    expect(match(command)?.id).toBe(id);
  });

  test("has unique audit IDs", () => {
    expect(new Set(BASELINE_RULES.map((rule) => rule.id)).size).toBe(BASELINE_RULES.length);
  });

  test.each([
    "", " ", "ls; rm -rf /tmp/example", "ls && touch /tmp/example", "ls || sh payload",
    "ls | sh", "ls &", "ls > /tmp/result", "ls 2>/tmp/result", "ls >> /tmp/result",
    "ls </tmp/input", "ls <<<data", "ls <<EOF\ndata\nEOF", "ls\npwd", "ls\rwhoami", "ls\n",
    "ls\0", "ls\u001b", "ls $(touch /tmp/example)", "ls `id`", "ls <(id)",
    "ls $HOME", "ls ${HOME}", "ls $((1+1))", "ls ~", "ls *", "ls ?.txt", "ls [ab]", "ls {a,b}",
    "ls #comment", "ls !history", "ls \\; pwd", "ls \\\npwd", "ls 'unfinished", 'ls "unfinished',
    'ls "$(id)"', "ls '$HOME'", "ls 'a;b'", "ls ''", "'ls -la'", "l\\s",
    "PATH=/tmp ls", "LD_PRELOAD=/tmp/payload.so ls", "env ls", "command ls", "sudo ls",
    "bash -c ls", "sh -c ls", "/tmp/ls", "./ls", "/bin/ls", "ls.exe", "lsof", "lsfoo",
    "ls -R", "ls --recursive", "ls --future-option", "ls --ignore='*'", "ls --color never",
    "ls https://example.com", "ls s3://bucket", "ls =payload", "pwd /tmp", "pwd --future-option",
    "stat", "stat --printf=%n README.md", "stat -c %n README.md", "uname /tmp", "whoami --help",
    "id root", "id --future-option", "basename -a a b", "basename a b", "dirname a b",
    "git status", "git diff --output=/tmp/result", "git -c core.fsmonitor=payload status",
    "find . -exec sh payload ;", "sed -n '1e id' README.md", "rg --pre payload query",
    "cat ~/.ssh/id_rsa", "printenv", "curl https://example.com", "touch /tmp/example",
  ])("leaves unsupported or executable syntax for review: %s", (command) => {
    expect(match(command)).toBeUndefined();
  });

  test("bounds command length and word count", () => {
    expect(match(`ls ${"a".repeat(4096)}`)).toBeUndefined();
    expect(match(`ls ${Array(129).fill("a").join(" ")}`)).toBeUndefined();
  });

  test("validates the whole tool input and local execution context", () => {
    expect(matchBaselineRule("bash", { command: "ls", cwd: "/work/my files", timeout: 30, pty: false, async: false }, "/work")?.id).toBe("local.ls");
    for (const input of [null, [], "ls", {}, { command: ["ls"] },
      { command: "ls", env: { LD_PRELOAD: "/tmp/payload.so" } },
      { command: "ls", env: {} }, { command: "ls", name: "service" }, { command: "ls", ready: {} },
      { command: "ls", pty: true }, { command: "ls", async: true }, { command: "ls", futureOption: true },
      ...[null, "https://example.com", "s3://bucket", "~", "$(id)", "", "/tmp\n"].map((cwd) => ({ command: "ls", cwd })),
      ...[null, "30", 0, -1, Infinity, NaN, 301].map((timeout) => ({ command: "ls", timeout })),
    ]) expect(matchBaselineRule("bash", input, "/work")).toBeUndefined();
    expect(matchBaselineRule("bash", { command: "ls" }, "s3://bucket")).toBeUndefined();
    expect(matchBaselineRule("custom_bash", { command: "ls" }, "/work")).toBeUndefined();
  });
});

describe("baseline approval integration", () => {
  const event = { type: "tool_call", toolCallId: "baseline", toolName: "bash", input: { command: "ls -la" } } as const;
  function fixture(config: Config = DEFAULT_CONFIG, hasUI = false) {
    const records: Array<{ outcome: string; detail?: string }> = [];
    let reviews = 0;
    let prompts = 0;
    const ctx = { cwd: "/work", hasUI, ui: { confirm: async () => { prompts++; return false; } } } as any;
    const options = {
      config,
      record: (_event: unknown, outcome: string, detail?: string) => records.push({ outcome, detail }),
      review: async () => {
        reviews++;
        return { outcome: "deny", risk_level: "low", user_authorization: "unknown", rationale: "reviewed" } as const;
      },
    };
    return { ctx, options, records, counts: () => ({ reviews, prompts }) };
  }

  test("bypasses model, credentials, user evidence and UI, while recording the rule ID", async () => {
    const f = fixture();
    expect(await handleToolCall(event as any, f.ctx, f.options)).toBeUndefined();
    expect(f.counts()).toEqual({ reviews: 0, prompts: 0 });
    expect(f.records).toEqual([{ outcome: "baseline_allow", detail: "local.ls" }]);
  });

  test("honors the audit switch on the fast path", async () => {
    const f = fixture({ ...DEFAULT_CONFIG, auditLog: false });
    expect(await handleToolCall(event as any, f.ctx, f.options)).toBeUndefined();
    expect(f.counts().reviews).toBe(0);
    expect(f.records).toEqual([]);
  });

  test("disabling the library or forcing tool review calls the model", async () => {
    for (const config of [
      { ...DEFAULT_CONFIG, baselineRules: false },
      { ...DEFAULT_CONFIG, toolRules: { bash: "review" as const } },
      { ...DEFAULT_CONFIG, mode: "yolo" as const, toolRules: { bash: "review" as const } },
    ]) {
      const f = fixture(config);
      expect(await handleToolCall(event as any, f.ctx, f.options)).toMatchObject({ block: true });
      expect(f.counts()).toEqual({ reviews: 1, prompts: 0 });
      expect(f.records[0].outcome).toBe("deny");
    }
  });

  test.each(["ask", "deny"] as const)("preserves explicit %s policies", async (policy) => {
    for (const config of [
      { ...DEFAULT_CONFIG, mode: policy },
      { ...DEFAULT_CONFIG, toolRules: { bash: policy } },
    ]) {
      const f = fixture(config, true);
      expect(await handleToolCall(event as any, f.ctx, f.options)).toMatchObject({ block: true });
      expect(f.counts()).toEqual({ reviews: 0, prompts: policy === "ask" ? 1 : 0 });
      expect(f.records[0].outcome).toBe(policy === "ask" ? "user_deny" : "policy_deny");
    }
  });

  test("an unrelated tool rule does not suppress the library", async () => {
    const f = fixture({ ...DEFAULT_CONFIG, toolRules: { edit: "deny" } });
    expect(await handleToolCall(event as any, f.ctx, f.options)).toBeUndefined();
    expect(f.counts().reviews).toBe(0);
  });

  test("a miss follows normal model approval, denial and failure handling", async () => {
    const unsafe = { ...event, input: { command: "ls; touch /tmp/example" } };
    const f = fixture();
    expect(await handleToolCall(unsafe as any, f.ctx, f.options)).toMatchObject({ block: true });
    expect(f.counts().reviews).toBe(1);
    expect(await handleToolCall(unsafe as any, f.ctx, {
      ...f.options, review: async () => ({ outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "authorized" }),
    })).toBeUndefined();
    expect(await handleToolCall(unsafe as any, f.ctx, {
      ...f.options, review: async () => { throw new Error("offline"); },
    })).toMatchObject({ block: true, reason: "Automatic review unavailable: offline" });
    expect(f.records.map((record) => record.outcome)).toEqual(["deny", "allow", "review_unavailable"]);
  });
});
