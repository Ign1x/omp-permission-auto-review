import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  configPath,
  loadEffectiveConfig,
  configSources,
  saveSessionConfig,
  clearSessionConfig,
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
import { sessionApprovals } from "./session-approvals.ts";
import { cancelReviews } from "./review-control.ts";
import { diagnosticHistory } from "./diagnostics.ts";
import { PROFILES } from "./profiles.ts";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";

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
  '/permission approvals list|clear|revoke <id>',
  '/permission budget <seconds>       Total review wait (up to 1800 seconds)',
  '/permission cancel                 Cancel active reviews; block their calls',
  '/permission manual                 Stop active reviews and ask you instead',
  '/permission history|doctor         Explain recent decisions and setup',
  '/permission profile inspect|workspace|full-access|custom',
  '/permission reviewer model|user',
  '/permission scope user|session     Where subsequent changes are saved',
  '/permission sources|session-reset',
].join("\n");

const COMMANDS = ["profile", "reviewer", "scope", "sources", "session-reset", "show", "path", "help", "reset", "mode", "fallback", "model", "timeout", "budget", "retries", "thinking", "max-tokens", "max-input", "audit", "baseline", "rule", "scoped", "explain", "approvals", "manual", "cancel", "history", "doctor"];
const saveScopes = new Map<string, "user" | "session">();
const scopeKey = (ctx: ExtensionCommandContext) => ctx.sessionManager?.getSessionId?.();
const saveScope = (ctx: ExtensionCommandContext) => saveScopes.get(scopeKey(ctx) ?? "") ?? "user";

export function formatConfig(config: Config): string {
  const rules = Object.entries(config.toolRules).sort(([a], [b]) => a.localeCompare(b));
  return [
    `mode: ${config.mode}`,
    `profile: ${config.profile} (explicit rules still apply)`,
    `approval reviewer: ${config.reviewer}`,
    `reviewer: ${config.model}`,
    `failure: ${config.failurePolicy}`,
    `thinking: ${config.reasoning}`,
    `timeout per attempt: ${seconds(config.timeoutMs)}`,
    `total review budget: ${seconds(config.reviewTimeoutMs)}`,
    `retries: ${config.maxRetries} (${config.maxRetries + 1} attempts maximum)`,
    `maximum review wait: ${seconds(reviewBudgetMs(config))}`,
    `OMP handler budget: at least ${seconds(handlerBudgetMs(config))} (adjusted automatically for this session)`,
    `max tokens: ${config.maxTokens}`,
    `max input: ${config.maxInputCharacters} UTF-8 bytes`,
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
  const current = () => loadEffectiveConfig(ctx, basePath, userPath);
  const save = (changes: Partial<Config>) => {
    const config = saveScope(ctx) === "session" ? saveSessionConfig(ctx, changes, basePath, userPath) : saveConfig(changes, basePath, userPath);
    sessionApprovals.revoke(ctx);
    return config;
  };
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
      case "profile": {
        const id = oneValue(values, "profile");
        const preset = PROFILES.find((p) => p.id === id);
        if (!preset) throw new Error("profile must be inspect, workspace, full-access, or custom");
        if (ctx.hasUI && !await ctx.ui.confirm(`Use ${preset.label}?`, `${preset.description}\nExplicit tool/scoped rules remain active. Save to: ${saveScope(ctx)}.`)) return;
        save(preset.changes);
        break;
      }
      case "reviewer": {
        const reviewer = oneValue(values, "reviewer");
        if (reviewer !== "model" && reviewer !== "user") throw new Error("reviewer must be model or user");
        save({ reviewer });
        break;
      }
      case "scope": {
        const scope = oneValue(values, "scope");
        if (scope !== "session" && scope !== "user") throw new Error("scope must be user or session");
        const key = scopeKey(ctx);
        if (!key) throw new Error("Selecting a save scope requires an active session");
        if (!saveScopes.has(key) && saveScopes.size >= 100) saveScopes.delete(saveScopes.keys().next().value!);
        saveScopes.set(key, scope);
        ctx.ui.notify(`Changes will be saved to ${scope}. Session overrides take priority over user settings.`, "info");
        return;
      }
      case "session-reset":
        if (values.length) throw new Error("session-reset takes no arguments");
        clearSessionConfig(ctx); sessionApprovals.revoke(ctx);
        ctx.ui.notify("Session settings and approvals cleared.", "info");
        return;
      case "sources":
        ctx.ui.notify(JSON.stringify(configSources(ctx, basePath, userPath), null, 2), "info");
        return;
      case "manual":
        if (values.length) throw new Error("manual takes no arguments");
        ctx.ui.notify(`Switched ${cancelReviews(ctx, true)} active review(s) to manual approval.`, "info");
        return;
      case "history":
        ctx.ui.notify(diagnosticHistory(ctx), "info");
        return;
      case "doctor": {
        const config = current();
        const model = config.model === "current" ? ctx.model : ctx.models.resolve(config.model);
        const settings = ctx.cwd ? findScopedSettings(ctx.cwd) : undefined;
        ctx.ui.notify([
          `Reviewer: ${model ? `${model.provider}/${model.id}` : `unavailable (${config.model})`}`,
          `Interactive approval: ${ctx.hasUI ? "available" : "unavailable; unresolved calls block"}`,
          `Total wait: ${seconds(reviewBudgetMs(config))}; /permission manual or Ctrl+Alt+A takes over`,
          `Config: ${basePath}; overrides: ${userPath}`,
          `OMP native approval mode: ${settings ? cfgToolsApprovalMode.get(settings) : "unavailable in this context"}`,
          "Only this extension should own approval. Disable overlapping permission extensions; OMP's native gate may still prompt unless tools.approvalMode is yolo.",
          "This extension checks tool calls; it does not install an OS sandbox.",
        ].join("\n"), "info");
        return;
      }
      case "cancel":
        if (values.length) throw new Error("cancel takes no arguments");
        ctx.ui.notify(`Cancelled ${cancelReviews(ctx)} active review(s).`, "info");
        return;
      case "budget": {
        const value = oneValue(values, "budget");
        if (!/^\d+(?:\.\d{1,3})?s?$/.test(value)) throw new Error("budget must be seconds, e.g. 20 or 20s");
        const ms = Math.round(Number(value.replace(/s$/, "")) * 1000);
        if (ms <= 0 || ms > 1800000) throw new Error("budget must be greater than 0 and at most 1800 seconds");
        save({ reviewTimeoutMs: ms });
        break;
      }
      case "approvals":
        if (!values.length || (values.length === 1 && values[0] === "list")) ctx.ui.notify(JSON.stringify(sessionApprovals.list(ctx, current()), null, 2), "info");
        else if (values[0] === "clear" && values.length === 1) { sessionApprovals.revoke(ctx); ctx.ui.notify("Session approvals cleared.", "info"); }
        else if (values[0] === "revoke" && values.length === 2) { sessionApprovals.revoke(ctx, values[1]); ctx.ui.notify("Session approval revoked.", "info"); }
        else throw new Error("usage: /permission approvals list|clear|revoke <id>");
        return;
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
          save({ scopedRules: [...current().scopedRules, rule] });
        } else throw new Error("usage: /permission scoped list|remove <id>|add <JSON rule>");
        break;
      }
      case "show":
        ctx.ui.notify(`${formatConfig(current())}\nSave changes to: ${saveScope(ctx)}\nUse /permission sources for configuration provenance.`, "info");
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
        sessionApprovals.revoke(ctx);
        ctx.ui.notify("Permission settings reset to managed defaults.", "info");
        return;
      case "mode": {
        const value = oneValue(values, "mode");
        if (!["review", "ask", "deny", "yolo"].includes(value)) throw new Error("mode must be review, ask, deny, or yolo");
        if (value === "yolo" && ctx.hasUI && !await ctx.ui.confirm("Enable YOLO mode?", "All tools will run without permission review.")) return;
        save({ mode: value as Mode, profile: "custom" });
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
  const advancedItems = ["Mode", "Reviewer model", "Failure policy", "Timeout (seconds)", "Retries", "Thinking", "Max tokens", "Max input", "Audit log", "Baseline rules", "Reset overrides", "Done"];
  const mainItems = ["Permission profile", "Approval reviewer", "Save changes to", "Total review budget", "Tool rules", "Scoped rules", "Session approvals", "Recent decisions", "Diagnostics", "Show settings", "Configuration sources", "Reset session settings", "Advanced", "Done"];
  while (true) {
    let config: Config;
    try { config = current(); } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    let choice = await ctx.ui.select(`Permissions (${config.profile}; ${config.reviewer} reviewer; save: ${saveScope(ctx)})`, mainItems);
    if (choice === "Advanced") {
      choice = await ctx.ui.select("Advanced permission settings", advancedItems);
      if (!choice || choice === "Done") continue;
    }
    const direct = { "Recent decisions": "history", "Diagnostics": "doctor", "Configuration sources": "sources", "Reset session settings": "session-reset" }[choice ?? ""];
    if (direct) { await handlePermissionCommand(direct, ctx, { basePath, userPath }); continue; }
    if (choice === "Permission profile") {
      const selected = await ctx.ui.select("Permission profile (explicit rules remain active)", PROFILES.map((p) => ({ label: p.label, description: p.description })));
      const preset = PROFILES.find((p) => p.label === selected);
      if (preset) await handlePermissionCommand(`profile ${preset.id}`, ctx, { basePath, userPath });
      continue;
    }
    if (choice === "Scoped rules") {
      const selected = await ctx.ui.select("Scoped rules", ["Add JSON rule", ...config.scopedRules.map((r) => r.id), "Back"]);
      if (!selected || selected === "Back") continue;
      if (selected === "Add JSON rule") {
        const json = await ctx.ui.input("Scoped rule JSON", '{"id":"tests","kind":"command","cwd":"/project","prefix":["bun","test"],"decision":"allow"}');
        if (json) await handlePermissionCommand(`scoped add ${json}`, ctx, { basePath, userPath });
      } else if (await ctx.ui.select(JSON.stringify(config.scopedRules.find((r) => r.id === selected), null, 2), ["Keep", "Remove"]) === "Remove") {
        await handlePermissionCommand(`scoped remove ${selected}`, ctx, { basePath, userPath });
      }
      continue;
    }
    if (choice === "Session approvals") {
      const grants = sessionApprovals.list(ctx, config);
      const labels = grants.map((g) => `${g.tool}: ${g.id}`);
      const selected = await ctx.ui.select("Session approvals", ["Clear all", ...labels, "Back"]);
      if (selected === "Clear all") sessionApprovals.revoke(ctx);
      else { const index = labels.indexOf(selected ?? ""); if (index >= 0) sessionApprovals.revoke(ctx, grants[index].id); }
      continue;
    }
    if (!choice || choice === "Done") return;
    if (choice === "Show settings") {
      ctx.ui.notify(formatConfig(config), "info");
      continue;
    }
    if (choice === "Reset overrides") {
      await handlePermissionCommand("reset", ctx, { basePath, userPath });
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
      "Approval reviewer": "reviewer", "Save changes to": "scope", "Total review budget": "budget",
      Mode: "mode", "Reviewer model": "model", "Failure policy": "fallback", "Timeout (seconds)": "timeout", Retries: "retries", Thinking: "thinking",
      "Max tokens": "max-tokens", "Max input": "max-input", "Audit log": "audit", "Baseline rules": "baseline",
    }[choice];
    if (!key) continue;
    let value: string | undefined;
    if (key === "reviewer") value = await ctx.ui.select("Who reviews unmatched actions?", ["model", "user"]);
    else if (key === "scope") value = await ctx.ui.select("Save subsequent settings to", ["user", "session"]);
    else if (key === "budget") value = await ctx.ui.input("Total review budget (seconds)", `Current: ${seconds(config.reviewTimeoutMs)}; includes all attempts`);
    else if (key === "mode") value = await ctx.ui.select("Permission mode", ["review", "ask", "deny", "yolo"]);
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
    : command === "baseline" ? ["on", "off", "list"]
    : command === "profile" ? PROFILES.map((p) => p.id) : command === "reviewer" ? ["model", "user"]
    : command === "scope" ? ["user", "session"] : command === "scoped" ? ["list", "add", "remove"]
    : command === "approvals" ? ["list", "clear", "revoke"] : [];
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
