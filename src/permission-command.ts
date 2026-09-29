import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  configPath,
  loadConfig,
  resetConfig,
  saveConfig,
  THINKING_LEVELS,
  type Config,
  type FailurePolicy,
  type Mode,
  type ToolPolicy,
  type ThinkingLevel,
} from "./config.ts";
import { syncHandlerBudget } from "./handler-budget.ts";
import { handlerBudgetMs, parseTimeoutSeconds, reviewBudgetMs, seconds } from "./timing.ts";
import { BASELINE_RULES } from "./baseline-rules.ts";
import { evaluatePolicy } from "./policy.ts";
import type { ScopedRule } from "./scoped-rules.ts";

const HELP = [
  "/permission                         Open settings",
  "/permission show|path|help|reset",
  "/permission mode review|ask|deny|yolo",
  "/permission fallback ask|deny",
  "/permission model <provider/model|current>",
  "/permission timeout <seconds>       Per attempt, e.g. 60 or 60s",
  "/permission retries <0-5>           Retries after the first attempt",
  "/permission thinking low|medium|high",
  "/permission max-tokens|max-input <number>",
  "/permission audit on|off",
  "/permission baseline on|off|list",
  "/permission rule [<tool> review|ask|allow|deny | remove <tool>]",
  '/permission scoped list|remove <id>|add <JSON rule>',
  '/permission explain <tool> <JSON input>  Evaluate without executing',
].join("\n");

const COMMANDS = ["show", "path", "help", "reset", "mode", "fallback", "model", "timeout", "retries", "thinking", "max-tokens", "max-input", "audit", "baseline", "rule", "scoped", "explain"];

export function formatConfig(config: Config): string {
  const rules = Object.entries(config.toolRules).sort(([a], [b]) => a.localeCompare(b));
  return [
    `mode: ${config.mode}`,
    `reviewer: ${config.model}`,
    `failure: ${config.failurePolicy}`,
    `thinking: ${config.reasoning}`,
    `timeout per attempt: ${seconds(config.timeoutMs)}`,
    `retries: ${config.maxRetries} (${config.maxRetries + 1} attempts maximum)`,
    `maximum review wait: ${seconds(reviewBudgetMs(config))}`,
    `OMP handler budget: at least ${seconds(handlerBudgetMs(config))} (adjusted automatically for this session)`,
    `max tokens: ${config.maxTokens}`,
    `max input: ${config.maxInputCharacters} characters`,
    `audit log: ${config.auditLog ? "on" : "off"}`,
    `baseline rules: ${config.baselineRules ? "on" : "off"} (${BASELINE_RULES.length} built-in rules; explicit tool rules take priority)`,
    `scoped rules: ${config.scopedRules.length}`,
    `tool rules: ${rules.length ? rules.map(([tool, policy]) => `${tool}=${policy}`).join(", ") : "none"}`,
  ].join("\n");
}

interface Paths {
  basePath?: string;
  userPath?: string;
}

export async function handlePermissionCommand(args: string, ctx: ExtensionCommandContext, paths: Paths = {}): Promise<void> {
  const basePath = paths.basePath ?? configPath();
  const userPath = paths.userPath ?? join(dirname(basePath), "user.json");
  const current = () => loadConfig(basePath, userPath);
  const save = (changes: Partial<Config>) => saveConfig(changes, basePath, userPath);
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const [command, ...values] = parts;

  if (!command) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/permission requires interactive mode; use /permission show or help.", "warning");
      return;
    }
    await openMenu(ctx, current, basePath, userPath);
    return;
  }

  try {
    switch (command) {
      case "explain": {
        const match = args.trim().match(/^explain\s+([\w.:-]+)\s+([\s\S]+)$/);
        if (!match) throw new Error("usage: /permission explain <tool> <JSON input>");
        ctx.ui.notify(JSON.stringify(evaluatePolicy({ toolName: match[1], input: JSON.parse(match[2]) }, ctx.cwd, current()), null, 2), "info");
        return;
      }
      case "scoped": {
        const rules = current().scopedRules;
        if (values.length === 0 || (values.length === 1 && values[0] === "list")) {
          ctx.ui.notify(JSON.stringify(rules, null, 2), "info");
          return;
        }
        if (values[0] === "remove" && values.length === 2) save({ scopedRules: rules.filter((r) => r.id !== values[1]) });
        else if (values[0] === "add") {
          const json = args.trim().replace(/^scoped\s+add\s+/, "");
          const rule = JSON.parse(json) as ScopedRule;
          // Validate the complete candidate before displaying or saving it.
          const { parseConfig } = await import("./config.ts");
          parseConfig({ ...current(), scopedRules: [...rules, rule] });
          if (ctx.hasUI && rule.decision === "allow" && !await ctx.ui.confirm("Save scoped permission?", JSON.stringify(rule, null, 2))) return;
          save({ scopedRules: [...rules, rule] });
        } else throw new Error("usage: /permission scoped list|remove <id>|add <JSON rule>");
        break;
      }
      case "show":
        ctx.ui.notify(formatConfig(current()), "info");
        return;
      case "path":
        ctx.ui.notify(`Managed defaults: ${basePath}\nUser settings: ${userPath}`, "info");
        return;
      case "help":
        ctx.ui.notify(HELP, "info");
        return;
      case "reset":
        if (values.length) throw new Error("reset takes no arguments");
        if (ctx.hasUI && !await ctx.ui.confirm("Reset permission settings?", `Remove user settings at ${userPath}? Managed defaults remain.`)) return;
        resetConfig(userPath);
        ctx.ui.notify("Permission settings reset to managed defaults.", "info");
        return;
      case "mode": {
        const value = oneValue(values, "mode");
        if (!["review", "ask", "deny", "yolo"].includes(value)) throw new Error("mode must be review, ask, deny, or yolo");
        if (value === "yolo" && ctx.hasUI && !await ctx.ui.confirm("Enable YOLO mode?", "All tools will run without permission review.")) return;
        save({ mode: value as Mode });
        break;
      }
      case "fallback": {
        const value = oneValue(values, "fallback");
        if (value !== "ask" && value !== "deny") throw new Error("fallback must be ask or deny");
        save({ failurePolicy: value as FailurePolicy });
        break;
      }
      case "model": {
        const value = oneValue(values, "model");
        if (value !== "current" && !ctx.models.resolve(value)) throw new Error(`model is unavailable: ${value}`);
        save({ model: value });
        break;
      }
      case "thinking": {
        const value = oneValue(values, "thinking");
        if (!THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error("thinking must be low, medium, or high");
        save({ reasoning: value as ThinkingLevel });
        break;
      }
      case "timeout":
        save({ timeoutMs: parseTimeoutSeconds(oneValue(values, "timeout (seconds)")) });
        break;
      case "retries": {
        const value = oneValue(values, "retries");
        if (!/^[0-5]$/.test(value)) throw new Error("retries must be an integer from 0 to 5");
        save({ maxRetries: Number(value) });
        break;
      }
      case "max-tokens":
      case "max-input": {
        const value = oneValue(values, command);
        if (!/^\d+$/.test(value)) throw new Error(`${command} must be a positive integer`);
        const key = command === "max-tokens" ? "maxTokens" : "maxInputCharacters";
        save({ [key]: Number(value) });
        break;
      }
      case "audit": {
        const value = oneValue(values, "audit");
        if (value !== "on" && value !== "off") throw new Error("audit must be on or off");
        save({ auditLog: value === "on" });
        break;
      }
      case "baseline": {
        const value = oneValue(values, "baseline");
        if (value === "list") {
          ctx.ui.notify([
            `Baseline rules: ${current().baselineRules ? "on" : "off"} (review mode only, unless an explicit tool rule applies)`,
            ...BASELINE_RULES.map((rule) => `${rule.id}: ${rule.command} — ${rule.description}`),
          ].join("\n"), "info");
          return;
        }
        if (value !== "on" && value !== "off") throw new Error("baseline must be on, off, or list");
        save({ baselineRules: value === "on" });
        break;
      }
      case "rule": {
        if (!values.length) {
          ctx.ui.notify(`Tool rules: ${formatConfig(current()).split("\n").at(-1)}`, "info");
          return;
        }
        const rules = { ...current().toolRules };
        if (values[0] === "remove" && values.length === 2) {
          delete rules[values[1]];
        } else if (values.length === 2 && ["review", "ask", "allow", "deny"].includes(values[1])) {
          if (values[1] === "allow" && ctx.hasUI && !await ctx.ui.confirm("Allow tool without review?", `Always allow ${values[0]}?`)) return;
          rules[values[0]] = values[1] as ToolPolicy;
        } else {
          throw new Error("usage: /permission rule <tool> review|ask|allow|deny, or rule remove <tool>");
        }
        save({ toolRules: rules });
        break;
      }
      default:
        throw new Error(`unknown setting: ${command}\n${HELP}`);
    }
    ctx.ui.notify(`Permission settings updated.\n${formatConfig(current())}`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

function oneValue(values: string[], name: string): string {
  if (values.length !== 1) throw new Error(`${name} requires one value; use /permission help`);
  return values[0];
}

async function openMenu(
  ctx: ExtensionCommandContext,
  current: () => Config,
  basePath: string,
  userPath: string,
): Promise<void> {
  const items = ["Mode", "Reviewer model", "Failure policy", "Timeout (seconds)", "Retries", "Thinking", "Max tokens", "Max input", "Audit log", "Baseline rules", "Tool rules", "Show settings", "Reset overrides", "Done"];
  while (true) {
    let config: Config;
    try { config = current(); } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    const choice = await ctx.ui.select(`Permission settings (${config.mode})`, items);
    if (!choice || choice === "Done") return;
    if (choice === "Show settings") {
      ctx.ui.notify(formatConfig(config), "info");
      continue;
    }
    if (choice === "Reset overrides") {
      if (await ctx.ui.confirm("Reset permission settings?", `Remove user settings at ${userPath}?`)) {
        resetConfig(userPath);
        ctx.ui.notify("Permission settings reset to managed defaults.", "info");
      }
      continue;
    }
    if (choice === "Tool rules") {
      const existing = Object.entries(config.toolRules).sort(([a], [b]) => a.localeCompare(b));
      const selected = await ctx.ui.select("Tool rules", ["Add rule", ...existing.map(([tool, policy]) => `${tool}: ${policy}`), "Back"]);
      if (!selected || selected === "Back") continue;
      const tool = selected === "Add rule" ? await ctx.ui.input("Tool name (exact match)", "bash, edit, write...")
        : existing.find(([name, policy]) => selected === `${name}: ${policy}`)?.[0];
      if (!tool) continue;
      const policy = await ctx.ui.select(`Rule for ${tool}`, ["review", "ask", "allow", "deny", "remove"]);
      if (!policy) continue;
      await handlePermissionCommand(`rule ${policy === "remove" ? `remove ${tool}` : `${tool} ${policy}`}`, ctx, { basePath, userPath });
      continue;
    }
    const key = {
      Mode: "mode", "Reviewer model": "model", "Failure policy": "fallback", "Timeout (seconds)": "timeout", Retries: "retries", Thinking: "thinking",
      "Max tokens": "max-tokens", "Max input": "max-input", "Audit log": "audit", "Baseline rules": "baseline",
    }[choice];
    if (!key) continue;
    let value: string | undefined;
    if (key === "mode") value = await ctx.ui.select("Permission mode", ["review", "ask", "deny", "yolo"]);
    else if (key === "fallback") value = await ctx.ui.select("When reviewer fails", ["ask", "deny"]);
    else if (key === "audit") value = await ctx.ui.select("Audit log", ["on", "off"]);
    else if (key === "baseline") value = await ctx.ui.select("Baseline rules", ["on", "off", "list"]);
    else if (key === "thinking") value = await ctx.ui.select("Reviewer thinking effort", [...THINKING_LEVELS]);
    else if (key === "model") {
      const selected = await ctx.ui.select("Reviewer model", ["current", ...ctx.models.list().map((model) => `${model.provider}/${model.id}`)]);
      value = selected;
    } else if (key === "timeout") value = await ctx.ui.input("Timeout per attempt (seconds)", `Current: ${seconds(config.timeoutMs)}; e.g. 60 or 60s (up to 300 seconds)`);
    else if (key === "retries") value = await ctx.ui.input("Retries after the first attempt", `Current: ${config.maxRetries}; 0–5 (2 means 3 attempts total)`);
    else value = await ctx.ui.input(key, "positive integer");
    if (!value) continue;
    await handlePermissionCommand(`${key} ${value}`, ctx, { basePath, userPath });
  }
}

function argumentCompletions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
  const [command, partial = ""] = prefix.trimStart().split(/\s+/, 2);
  const values = !prefix.includes(" ") ? COMMANDS : command === "mode" ? ["review", "ask", "deny", "yolo"]
    : command === "thinking" ? [...THINKING_LEVELS] : command === "retries" ? ["0", "1", "2", "3", "4", "5"]
    : command === "fallback" ? ["ask", "deny"] : command === "audit" ? ["on", "off"]
    : command === "baseline" ? ["on", "off", "list"] : [];
  const match = prefix.includes(" ") ? partial : command;
  const completions = values.filter((value) => value.startsWith(match)).map((value) => ({
    value: prefix.includes(" ") ? `${command} ${value}` : value,
    label: value,
    description: `Set permission ${command || "command"}`,
  }));
  return completions.length ? completions : null;
}

export function registerPermissionCommand(omp: ExtensionAPI): void {
  omp.registerCommand("permission", {
    description: "Configure automatic tool permission review",
    getArgumentCompletions: argumentCompletions,
    handler: async (args, ctx) => {
      await handlePermissionCommand(args, ctx);
      syncHandlerBudget(ctx);
    },
  });
}
