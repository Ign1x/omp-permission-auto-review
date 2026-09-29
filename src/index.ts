import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { configPath, loadConfig, type Config } from "./config.ts";
import { evaluatePolicy } from "./policy.ts";
import { modelReview } from "./model-review.ts";
export { modelReview, reviewEvidence } from "./model-review.ts";
import { registerPermissionCommand } from "./permission-command.ts";
import { syncHandlerBudget } from "./handler-budget.ts";
import { mayAutoApprove, type Decision } from "./review.ts";

function audit(event: ToolCallEvent, outcome: string, detail?: string): void {
  const path = join(dirname(configPath()), "logs", "review.jsonl");
  const fingerprint = createHash("sha256").update(JSON.stringify([event.toolName, event.input])).digest("hex");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify({
      timestamp: new Date().toISOString(),
      tool: event.toolName,
      fingerprint,
      outcome,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("omp-permission-auto-review: audit write failed", error);
  }
}

export type Review = (event: ToolCallEvent, ctx: ExtensionContext, config: Config) => Promise<Decision>;

export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  options: { review?: Review; config?: Config; record?: typeof audit } = {},
): Promise<{ block: true; reason: string } | undefined> {
  const record = options.record ?? audit;
  let config: Config | undefined;
  const recordDecision = (outcome: string, detail: string) => {
    if (config?.auditLog !== false) record(event, outcome, detail);
  };
  try {
    config = options.config ?? loadConfig();
    const policy = evaluatePolicy(event, ctx.cwd, config);
    if (policy.action === "allow") {
      recordDecision(policy.source === "baseline" ? "baseline_allow" : "policy_allow", policy.ruleId ?? policy.reason);
      return undefined;
    }
    if (policy.action === "deny") {
      recordDecision("policy_deny", policy.reason);
      return { block: true, reason: `Permission rule denies ${event.toolName}: ${policy.reason}` };
    }
    if (policy.action === "ask") {
      const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
      const approved = ctx.hasUI && await ctx.ui.confirm("Permission required", `${policy.reason}\n\n${call}\n\nApprove this call?`);
      recordDecision(approved ? "user_allow" : "user_deny", "ask policy");
      return approved ? undefined : { block: true, reason: `Permission approval required for ${event.toolName}` };
    }
    const decision = await (options.review ?? modelReview)(event, ctx, config);
    if (mayAutoApprove(decision)) {
      recordDecision("allow", decision.rationale);
      return undefined;
    }
    if (decision.outcome === "deny" || decision.risk_level === "critical") {
      recordDecision("deny", decision.rationale);
      return { block: true, reason: `Automatic review denied: ${decision.rationale}` };
    }
    const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
    if (ctx.hasUI && await ctx.ui.confirm("Permission review", `${decision.rationale}\n\n${call}\n\nApprove this call?`)) {
      recordDecision("user_allow", decision.rationale);
      return undefined;
    }
    recordDecision("user_deny", decision.rationale);
    return { block: true, reason: `Permission review requires user approval: ${decision.rationale}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (config?.failurePolicy === "deny") {
      recordDecision("review_unavailable", reason);
      return { block: true, reason: `Automatic review unavailable: ${reason}` };
    }
    if (ctx.hasUI) {
      const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
      try {
        const approved = await ctx.ui.confirm("Automatic review unavailable", `${reason}\n\n${call}\n\nApprove this call?`);
        recordDecision(approved ? "user_allow_unavailable" : "user_deny_unavailable", reason);
        if (approved) return undefined;
      } catch (confirmError) {
        recordDecision("review_unavailable", `${reason}; confirmation failed: ${String(confirmError)}`);
      }
    } else {
      recordDecision("review_unavailable", reason);
    }
    return { block: true, reason: `Automatic review unavailable: ${reason}` };
  }
}

export default function ompPermissionAutoReview(omp: ExtensionAPI): void {
  registerPermissionCommand(omp);
  omp.on("session_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("before_agent_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("turn_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
}
