import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCommandChain, parseCommands } from "./command-parser.ts";

/** A single leading `cd /absolute/path && ...` is evaluated in its actual directory.
 * Other stateful shell syntax stays unsupported; failed cd must not run the query.
 */
export function inspectionCommands(command: string, cwd: string): { commands: string[][]; cwd: string } | undefined {
  const parsed = parseCommandChain(command);
  if (!parsed) return;
  if (parsed.commands[0][0] !== "cd") {
    const commands = parseCommands(command);
    return commands ? { commands, cwd } : undefined;
  }
  const [first, ...commands] = parsed.commands;
  const args = first.slice(1);
  if (args[0] === "--") args.shift();
  if (args.length !== 1 || !isAbsolute(args[0]) || args[0].split("/").includes("..") ||
      parsed.operators[0] !== "&&" || parsed.operators.some((op) => op !== "&&" && op !== "|") || !commands.length) return;
  // Reuse the stateful-command checks, preserving all remaining operators.
  const rest = commands.map((argv, i) => `${i ? parsed.operators[i] + " " : ""}${argv.map((s) => `'${s}'`).join(" ")}`).join(" ");
  if (!parseCommands(rest)) return;
  try {
    const target = realpathSync(args[0]);
    if (!statSync(target).isDirectory()) return;
    return { commands, cwd: target };
  } catch { return; }
}

function workspaceDirectory(directory: string, workspace: string): string | undefined {
  try {
    const root = realpathSync(workspace), target = realpathSync(directory);
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !statSync(target).isDirectory()) return;
    return target;
  } catch { return; }
}

/** Git's apparent reads may invoke external diff/textconv/filter/fsmonitor/pager programs.
 * Read effective config (includes and inherited config overrides included) without
 * running those programs. No cache: configuration can change between tool calls.
 * Standard git, PATH and shell startup remain trusted, as for other baseline tools.
 */
function simplePager(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "cat") return true;
  return /^less(?: -[FRX]+)?$/.test(value) && (!process.env.LESS || /^-[FRX]+$/.test(process.env.LESS));
}

function gitHasNoHelpers(cwd: string, piped: boolean, deadline: number): boolean {
  if (!piped && !simplePager(process.env.GIT_PAGER ?? process.env.PAGER)) return false;
  if (["GIT_EXTERNAL_DIFF", "GIT_CONFIG", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]
    .some((key) => !!process.env[key])) return false;
  try {
    const timeout = () => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("inspection check budget exhausted");
      return Math.min(250, remaining);
    };
    const repo = spawnSync("git", ["--no-pager", "rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf8", timeout: timeout(), maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"],
    });
    if (repo.error || repo.status !== 0 || repo.stdout.trim() !== "true") return false;
    const config = spawnSync("git", ["--no-pager", "config", "--null", "--get-regexp", "^(diff\\..*|filter\\..*|extensions\\.partialclone|remote\\..*\\.promisor|core\\.fsmonitor|core\\.pager|pager\\..*)$"], {
      cwd, encoding: "utf8", timeout: timeout(), maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
    });
    if (config.error || (config.status !== 0 && config.status !== 1)) return false;
    if (config.status === 1 && (config.stdout !== "" || config.stderr !== "")) return false;
    const safe = config.stdout.split("\0").filter(Boolean).every((entry) => {
      const split = entry.indexOf("\n");
      if (split < 0) return false;
      const key = entry.slice(0, split).toLowerCase();
      const value = entry.slice(split + 1);
      if (key === "core.fsmonitor" || /^remote\..*\.promisor$/.test(key)) return value === "false";
      if (key === "extensions.partialclone") return false;
      if (key === "diff.submodule") return value === "short";
      if (key === "core.pager" || key.startsWith("pager.")) return piped || simplePager(value) || value === "false";
      return !/^(?:diff\.external|diff\..*\.(?:command|textconv)|filter\..*\.(?:clean|smudge|process))$/.test(key);
    });
    if (!safe) return false;
    // Submodule status can inspect another repository with different helpers.
    const index = spawnSync("git", ["--no-pager", "ls-files", "--stage", "-z", "--full-name", "--", ":/"], {
      cwd, encoding: "utf8", timeout: timeout(), maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return !index.error && index.status === 0 && !index.stdout.split("\0").some((entry) => entry.startsWith("160000 "));
  } catch { return false; }
}

const DIFF_FLAGS = new Set([
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary",
  "--cached", "--staged", "--check", "--exit-code", "--quiet", "--patch", "-p", "-s",
  "--no-patch", "--no-ext-diff", "--no-textconv", "--no-color", "--color=never",
  "--no-renames", "-w", "-b", "--ignore-space-at-eol", "--ignore-blank-lines",
]);
const STATUS_FLAGS = new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "-uno", "--untracked-files=normal", "--untracked-files=all"]);

function gitQuery(argv: string[], directory: string, workspace: string, piped: boolean, helpers: (cwd: string, piped: boolean) => boolean): boolean {
  const args = argv.slice(1);
  if (args[0] === "-C") {
    const path = args[1];
    if (!path || path.startsWith("-") || path.split("/").includes("..")) return false;
    directory = resolve(directory, path); args.splice(0, 2);
  }
  const operation = args.shift();
  if (operation !== "diff" && operation !== "status") return false;
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("-")) {
      if (!(operation === "diff" ? DIFF_FLAGS : STATUS_FLAGS).has(arg) &&
          !(operation === "diff" && /^(?:-U|--unified=)\d{1,5}$/.test(arg))) return false;
    } else if (!arg || /[^\p{L}\p{M}\p{N}_./,+%\- ]/u.test(arg)) return false;
  }
  const target = workspaceDirectory(directory, workspace);
  return !!target && helpers(target, piped);
}

function outputFilter(argv: string[]): boolean {
  const [name, ...args] = argv;
  if (name === "head" || name === "tail") {
    return args.length === 0 || (args.length === 1 && /^-\d{1,6}$/.test(args[0])) ||
      (args.length === 2 && ["-n", "-c"].includes(args[0]) && /^\d{1,6}$/.test(args[1]));
  }
  // No filenames or executable sed expressions: only bounded stdin display.
  return name === "sed" && args.length === 2 && args[0] === "-n" && /^\d{1,6}(?:,\d{1,6})?p$/.test(args[1]);
}

export function isInspectionCommand(command: string, cwd: string, workspace: string, localQuery: (argv: string[]) => boolean): boolean {
  const chain = inspectionCommands(command, cwd);
  if (!chain || !workspaceDirectory(chain.cwd, workspace)) return false;
  // Filters only consume stdin in a pipe. A command such as `head secret` is
  // deliberately not covered by this rule.
  const parsed = parseCommandChain(command)!;
  const operators = parsed.operators;
  const offset = parsed.commands[0][0] === "cd" ? 1 : 0;
  // Reuse probes only within this evaluation, and bound the whole local check.
  const deadline = performance.now() + 750;
  const checked = new Map<string, boolean>();
  const helpers = (cwd: string, piped: boolean) => {
    const key = JSON.stringify([cwd, piped]);
    if (!checked.has(key)) checked.set(key, gitHasNoHelpers(cwd, piped, deadline));
    return checked.get(key)!;
  };
  return chain.commands.every((argv, i) => localQuery(argv) ||
    (argv[0] === "git" && gitQuery(argv, chain.cwd, workspace, operators[i + offset] === "|", helpers)) ||
    (i > 0 && operators[i - 1 + offset] === "|" && outputFilter(argv)));
}
