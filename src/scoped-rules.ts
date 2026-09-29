import { inspectionCommands } from "./inspection-commands.ts";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ordinaryBashInput, parseCommands } from "./command-parser.ts";
import { isWorkspaceRead, ordinaryPath } from "./workspace-read.ts";
import type { ToolAction } from "./policy.ts";

type BaseRule = { id: string; decision: "allow" | "ask" | "deny"; reason?: string };
export type ScopedRule = BaseRule & (
  { kind: "command"; cwd: string; prefix: string[] } |
  { kind: "path"; tool: "read" | "write"; root: string }
);

export function validateScopedRules(value: unknown): asserts value is ScopedRule[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("scopedRules must be an array of at most 256 rules");
  const ids = new Set<string>();
  for (const r of value) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[\w.-]{1,80}$/.test(r.id) || ids.has(r.id) || !["allow", "ask", "deny"].includes(r.decision)) throw new Error("invalid or duplicate scoped rule");
    ids.add(r.id);
    if (r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > 600)) throw new Error("invalid rule reason");
    const fields = r.kind === "command" ? ["id", "kind", "decision", "reason", "cwd", "prefix"] : ["id", "kind", "decision", "reason", "tool", "root"];
    if (Object.keys(r).some((k) => !fields.includes(k))) throw new Error(`unknown field in rule ${r.id}`);
    if (r.kind === "command") {
      if (typeof r.cwd !== "string" || !isAbsolute(r.cwd) || !ordinaryPath(r.cwd) || !Array.isArray(r.prefix) || !r.prefix.length || r.prefix.length > 128 || r.prefix.some((s: unknown) => typeof s !== "string" || !s || s.length > 1000)) throw new Error("command rules require an absolute cwd and token prefix");
      const parsed = parseCommands(r.prefix.map((s: string) => `'${s}'`).join(" "));
      if (!parsed || parsed.length !== 1 || JSON.stringify(parsed[0]) !== JSON.stringify(r.prefix)) throw new Error("prefix must contain literal command tokens");
      if (r.decision === "allow" && (r.prefix.length < 2 || /^(?:.*\/)?(?:sh|bash|zsh|fish|env|sudo|doas|command|exec|eval|python\d*(?:\.\d+)?|node|bun|perl|ruby)$/.test(r.prefix[0]) && !(["bun"].includes(r.prefix[0]) && ["test", "run"].includes(r.prefix[1])))) throw new Error("allow prefix is too broad; use a specific command or session approval");
    } else if (r.kind !== "path" || !["read", "write"].includes(r.tool) || typeof r.root !== "string" || !isAbsolute(r.root) || !ordinaryPath(r.root)) throw new Error("path rules require read/write and an absolute root");
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function canonicalCwd(cwd: string): string | undefined {
  try { return isAbsolute(cwd) && ordinaryPath(cwd) ? realpathSync(cwd) : undefined; } catch { return; }
}

/** Resolve writes through the nearest existing ancestor; never follow dangling links. */
export function writeWithin(input: unknown, cwd: string, root: string): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const call = input as Record<string, unknown>;
  if (Object.keys(call).some((k) => !["path", "content"].includes(k)) || typeof call.path !== "string" || typeof call.content !== "string" || !ordinaryPath(call.path)) return false;
  try {
    const base = realpathSync(root);
    const target = resolve(cwd, call.path);
    if (!inside(resolve(root), target)) return false;
    let ancestor = target;
    for (;;) {
      try {
        lstatSync(ancestor);
        const real = realpathSync(ancestor);
        if (!inside(base, real)) return false;
        const stat = statSync(real);
        return ancestor === target ? stat.isFile() : stat.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        // An existing dangling symlink cannot be treated as a missing component.
        try { lstatSync(ancestor); return false; } catch { /* missing */ }
        const parent = dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }
  } catch { return false; }
}

export function matchingRules(event: ToolAction, cwd: string, rules: ScopedRule[]): ScopedRule[] {
  if (event.toolName === "bash" && ordinaryBashInput(event.input)) {
    const call = event.input;
    if (call.cwd !== undefined && !ordinaryPath(call.cwd)) return [];
    const chain = inspectionCommands(call.command, resolve(cwd, call.cwd ?? "."));
    const actualCwd = chain && canonicalCwd(chain.cwd);
    const commands = chain?.commands;
    if (!actualCwd || !commands) return [];
    const permitAllows = !!parseCommands(call.command);
    const matches = commands.map((argv) => rules.filter((r) => (permitAllows || r.decision !== "allow") && r.kind === "command" && canonicalCwd(r.cwd) === actualCwd && r.prefix.every((word, i) => argv[i] === word)));
    // Any denial/prompt applies; allow requires coverage for every segment.
    return [...new Set(matches.flat().filter((r) => r.decision !== "allow" || matches.every((group) => group.some((r) => r.decision === "allow"))))];
  }
  return rules.filter((r) => {
    if (r.kind !== "path" || r.tool !== event.toolName) return false;
    if (r.tool === "write") return writeWithin(event.input, cwd, r.root);
    const call = event.input as Record<string, unknown> | null;
    if (!call || typeof call.path !== "string" || !isAbsolute(cwd)) return false;
    // Preserve selectors while resolving relative paths against the caller.
    return isWorkspaceRead({ ...call, path: resolve(cwd, call.path) }, r.root);
  });
}
