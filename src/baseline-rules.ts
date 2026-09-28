/**
 * A deliberately small allow library for ordinary local query utilities.
 * Rules match the entire input, never a command prefix. Unsupported syntax is
 * a rule miss, not a denial: the normal reviewer still decides what to do.
 * This assumes OMP's execution environment and standard utilities are trusted;
 * it does not attest PATH, shell startup code, or executable contents.
 */
export interface BaselineRule {
  readonly id: string;
  readonly command: string;
  readonly description: string;
  readonly matches: (args: readonly string[]) => boolean;
}

// Only literal words, spaces, tabs and quotes. Reject expansions and shell
// control characters even inside quotes, rather than trying to implement shell.
function literalWords(command: string): string[] | undefined {
  if (!command || command.length > 4096 || /[^\p{L}\p{N}_./=,+%\- '"\t]/u.test(command)) return;
  const words: string[] = [];
  let quote = "";
  let word = "";
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return;
  if (started) words.push(word);
  if (!words.length || words.length > 128) return;
  return words;
}

function localPath(value: unknown): value is string {
  // In particular, exclude OMP URL filesystems, ~ and shell expansions.
  return typeof value === "string" && value.length > 0 && !/[^\p{L}\p{N}_./,+%\- ]/u.test(value);
}

function flagsAndPaths(
  args: readonly string[], shortFlags: string, longFlags: readonly string[], minPaths = 0, maxPaths = 128,
): boolean {
  let paths = 0;
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
    } else if (options && arg.startsWith("-")) {
      if (longFlags.includes(arg)) continue;
      if (arg.startsWith("--") || arg.length < 2 || ![...arg.slice(1)].every((char) => shortFlags.includes(char))) return false;
    } else {
      if (!localPath(arg)) return false;
      paths++;
    }
  }
  return paths >= minPaths && paths <= maxPaths;
}

// Keep each rule's argument grammar next to its stable audit ID. New rules
// should include positive cases and examples that MUST go to model review.
export const BASELINE_RULES: readonly BaselineRule[] = [
  {
    id: "local.pwd", command: "pwd", description: "Working directory: no arguments, -L or -P",
    matches: (args) => args.length === 0 || (args.length === 1 && ["-L", "-P"].includes(args[0])),
  },
  {
    id: "local.ls", command: "ls", description: "Local directory listing with selected display flags; no recursion",
    matches: (args) => flagsAndPaths(args, "aAbBdFghHiklLnpqQrSstuvx1", [
      "--all", "--almost-all", "--directory", "--human-readable", "--inode", "--numeric-uid-gid",
      "--reverse", "--size", "--classify", "--literal", "--color=auto", "--color=always", "--color=never",
    ]),
  },
  {
    id: "local.stat", command: "stat", description: "Local file metadata: -L, -f, -t and their long forms",
    matches: (args) => flagsAndPaths(args, "Lft", ["--dereference", "--file-system", "--terse"], 1),
  },
  {
    id: "local.uname", command: "uname", description: "System identity with standard information flags",
    matches: (args) => flagsAndPaths(args, "asnrvmpio", [
      "--all", "--kernel-name", "--nodename", "--kernel-release", "--kernel-version",
      "--machine", "--processor", "--hardware-platform", "--operating-system",
    ], 0, 0),
  },
  {
    id: "local.whoami", command: "whoami", description: "Current username, without arguments",
    matches: (args) => args.length === 0,
  },
  {
    id: "local.id", command: "id", description: "Current user identity: no arguments or one selected flag",
    matches: (args) => args.length === 0 || (args.length === 1 && ["-u", "-g", "-G", "-un", "-gn", "-Gn"].includes(args[0])),
  },
  {
    id: "local.basename", command: "basename", description: "Extract a filename from one literal local path",
    matches: (args) => flagsAndPaths(args, "", [], 1, 1),
  },
  {
    id: "local.dirname", command: "dirname", description: "Extract a parent from one literal local path",
    matches: (args) => flagsAndPaths(args, "", [], 1, 1),
  },
];

export function matchBaselineRule(tool: string, input: unknown, cwd: string): BaselineRule | undefined {
  if (tool !== "bash" || !input || typeof input !== "object" || Array.isArray(input)) return;
  const call = input as Record<string, unknown>;
  // env, service startup, PTY, background execution and future unknown options
  // can change what execution means, even when the command text looks harmless.
  if (Object.keys(call).some((key) => !["command", "cwd", "timeout", "pty", "async"].includes(key))) return;
  if (typeof call.command !== "string" || !localPath(cwd)) return;
  if (Object.hasOwn(call, "cwd") && !localPath(call.cwd)) return;
  if (Object.hasOwn(call, "timeout") && (typeof call.timeout !== "number" || !Number.isFinite(call.timeout) || call.timeout <= 0 || call.timeout > 300)) return;
  if (Object.hasOwn(call, "pty") && call.pty !== false) return;
  if (Object.hasOwn(call, "async") && call.async !== false) return;
  const words = literalWords(call.command);
  if (!words) return;
  const [command, ...args] = words;
  return BASELINE_RULES.find((rule) => rule.command === command && rule.matches(args));
}
