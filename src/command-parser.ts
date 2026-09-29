export interface CommandChain { commands: string[][]; operators: string[] }

/** Preserve operators so callers can distinguish directory changes from pipelines. */
export function parseCommandChain(command: string): CommandChain | undefined {
  if (!command || command.length > 4096 || /[^\p{L}\p{M}\p{N}_./=,+%\- '"\t;&|]/u.test(command)) return;
  const commands: string[][] = [];
  const operators: string[] = [];
  let words: string[] = [], word = "", quote = "", started = false;
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (";&|".includes(char)) return;
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === " " || char === "\t") flush();
    else if (";&|".includes(char)) {
      flush();
      if (!words.length) return;
      commands.push(words); words = [];
      let operator = char;
      if (char === "&") { if (command[++i] !== "&") return; operator = "&&"; }
      else if (command[i + 1] === char) { if (char === ";") return; i++; operator += char; }
      operators.push(operator);
    } else { word += char; started = true; }
  }
  flush();
  if (quote || !words.length) return;
  commands.push(words);
  if (commands.length > 32 || commands.some((argv) => argv.length > 128 || !/^[\p{L}\p{N}_.\/-]+$/u.test(argv[0]))) return;
  return { commands, operators };
}

/** Scoped prefix rules continue to reject stateful compound commands. */
export function parseCommands(command: string): string[][] | undefined {
  const parsed = parseCommandChain(command);
  if (!parsed) return;
  const { commands } = parsed;
  if (commands.length > 1 && commands.some((argv) => ["cd", "pushd", "popd", "export", "unset", "alias", "unalias", "source", ".", "set", "eval", "exec", "read", "typeset", "declare", "local", "readonly", "shift", "umask", "ulimit", "trap", "hash", "builtin"].includes(argv[0]))) return;
  return commands;
}

export function ordinaryBashInput(input: unknown): input is { command: string; cwd?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const call = input as Record<string, unknown>;
  return typeof call.command === "string" && Object.keys(call).every((k) => ["command", "cwd", "timeout", "pty", "async"].includes(k)) &&
    (!Object.hasOwn(call, "cwd") || typeof call.cwd === "string") &&
    (!Object.hasOwn(call, "timeout") || (typeof call.timeout === "number" && Number.isFinite(call.timeout) && call.timeout > 0 && call.timeout <= 300)) &&
    (!Object.hasOwn(call, "pty") || call.pty === false) && (!Object.hasOwn(call, "async") || call.async === false);
}
