import { randomUUID } from "node:crypto";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, saveConfig, type Config } from "./config.ts";
import { ordinaryBashInput, parseCommands } from "./command-parser.ts";
import { canonicalCwd, validateScopedRules, type ScopedRule } from "./scoped-rules.ts";
import { resolve } from "node:path";
import { sessionApprovals, policyFingerprint, type SessionApprovals } from "./session-approvals.ts";
import { authorizationRevision, StaleAuthorizationError } from "./evidence.ts";

export interface ApprovalOptions {
  config?: Config;
  approvals?: SessionApprovals;
  saveRule?: (rule: ScopedRule) => void;
  currentConfig?: () => Config;
}

export function proposedCommandRule(event: ToolCallEvent, ctx: ExtensionContext): ScopedRule | undefined {
  if (event.toolName !== "bash" || !ordinaryBashInput(event.input)) return;
  const words = parseCommands(event.input.command);
  const cwd = canonicalCwd(resolve(ctx.cwd, event.input.cwd ?? "."));
  if (!words || words.length !== 1 || !cwd) return;
  // Propose all existing tokens. Shorter/broader prefixes are an explicit settings action.
  const rule: ScopedRule = { id: `approved-${randomUUID()}`, kind: "command", cwd, prefix: words[0], decision: "allow", reason: "Explicitly saved from an approval dialog" };
  try { validateScopedRules([rule]); return rule; } catch { return; }
}

export async function requestApproval(
  event: ToolCallEvent, ctx: ExtensionContext, title: string, reason: string, options: ApprovalOptions = {},
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
  const message = `${reason}\n\nWorking directory: ${ctx.cwd}\n${call}`;
  const config = options.config;
  const revision = authorizationRevision(ctx);
  const approvals = options.approvals ?? sessionApprovals;
  const fresh = () => {
    if (authorizationRevision(ctx) !== revision || (config && policyFingerprint((options.currentConfig ?? (() => config))()) !== policyFingerprint(config))) throw new StaleAuthorizationError();
    return true;
  };
  if (!ctx.ui.select) {
    const approved = await ctx.ui.confirm(title, `${message}\n\nApprove this call?`);
    fresh();
    return approved;
  }
  const candidate = config ? proposedCommandRule(event, ctx) : undefined;
  const choices = ["Allow once"];
  if (config && approvals.key(event, ctx)) choices.push("Allow exact call for this session");
  if (candidate) choices.push("Save command rule…");
  choices.push("Deny");
  const selected = await ctx.ui.select(`${title}\n${message}`, choices);
  if (!fresh()) return false;
  if (selected === "Allow once") return true;
  if (selected === "Allow exact call for this session" && config) return approvals.grant(event, ctx, config);
  if (selected === "Save command rule…" && candidate && config) {
    if (!await ctx.ui.confirm("Save command prefix rule?", `${JSON.stringify(candidate, null, 2)}\n\nThis permits the displayed tokens and additional trailing arguments in this working directory. It persists across sessions.`)) return false;
    if (!fresh()) return false;
    try {
      (options.saveRule ?? ((rule) => {
        const latest = loadConfig();
        saveConfig({ scopedRules: [...latest.scopedRules, rule] });
      }))(candidate);
      return true;
    } catch (error) {
      ctx.ui.notify(`Rule was not saved; call remains blocked: ${String(error)}`, "error");
      return false;
    }
  }
  return false;
}
