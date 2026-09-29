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
import { requestApproval, type ApprovalOptions } from "./approval.ts";
import { sessionApprovals } from "./session-approvals.ts";
import { policyFingerprint } from "./session-approvals.ts";
import { authorizationRevision, StaleAuthorizationError } from "./evidence.ts";
import { abortable, startReview, cancelReviews, ReviewCancelledError, ManualTakeoverError } from "./review-control.ts";
import { decisionFeedback } from "./review-feedback.ts";
import { recordDiagnostic } from "./diagnostics.ts";

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

export type Review = (event: ToolCallEvent, ctx: ExtensionContext, config: Config, signal?: AbortSignal) => Promise<Decision>;

export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  options: ApprovalOptions & { review?: Review; record?: typeof audit; signal?: AbortSignal } = {},
): Promise<{ block: true; reason: string } | undefined> {
  const record = options.record ?? audit;
  const started = performance.now();
  let config: Config | undefined;
  let revision: string | undefined;
  const recordDecision = (outcome: string, detail: string) => {
    decisionFeedback(ctx, event, outcome, detail);
    recordDiagnostic(ctx, event, outcome, detail, performance.now() - started);
    if (config?.auditLog !== false) record(event, outcome, detail);
  };
  try {
    config = options.config ?? loadConfig();
    revision = authorizationRevision(ctx);
    const policy = evaluatePolicy(event, ctx.cwd, config);
    if (policy.action === "allow") {
      recordDecision(policy.source === "baseline" ? "baseline_allow" : "policy_allow", policy.ruleId ?? policy.reason);
      return undefined;
    }
    if (policy.action === "deny") {
      recordDecision("policy_deny", policy.reason);
      return { block: true, reason: `Permission rule denies ${event.toolName}: ${policy.reason}` };
    }
    if ((options.approvals ?? sessionApprovals).has(event, ctx, config)) {
      recordDecision("session_allow", "Explicit approval for this exact call in this session");
      return undefined;
    }
    if (policy.action === "ask") {
      const approved = await requestApproval(event, ctx, "Permission required", policy.reason, { ...options, config, currentConfig: options.currentConfig ?? (options.config ? () => options.config! : loadConfig) });
      recordDecision(approved ? "user_allow" : "user_deny", "ask policy");
      return approved ? undefined : { block: true, reason: `Permission approval required for ${event.toolName}` };
    }
    const running = startReview(ctx, options.signal);
    let decision: Decision;
    try {
      running.signal.throwIfAborted();
      decision = await abortable(options.review ? options.review(event, ctx, config, running.signal)
        : modelReview(event, ctx, config, undefined, { signal: running.signal }), running.signal);
    } finally { running.dispose(); }
    const latest = options.currentConfig ? options.currentConfig() : options.config ?? loadConfig();
    if (authorizationRevision(ctx) !== revision || policyFingerprint(latest) !== policyFingerprint(config)) throw new StaleAuthorizationError();
    if (mayAutoApprove(decision)) {
      recordDecision("allow", decision.rationale);
      return undefined;
    }
    if (decision.outcome === "deny" || decision.risk_level === "critical") {
      recordDecision("deny", decision.rationale);
      return { block: true, reason: `Automatic review denied: ${decision.rationale}` };
    }
    if (await requestApproval(event, ctx, "Permission review", decision.rationale, { ...options, config, currentConfig: options.currentConfig ?? (options.config ? () => options.config! : loadConfig) })) {
      recordDecision("user_allow", decision.rationale);
      return undefined;
    }
    recordDecision("user_deny", decision.rationale);
    return { block: true, reason: `Permission review requires user approval: ${decision.rationale}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (revision !== undefined && authorizationRevision(ctx) !== revision) {
      const detail = new StaleAuthorizationError().message;
      recordDecision("stale_authorization", detail);
      return { block: true, reason: detail };
    }
    if (error instanceof StaleAuthorizationError || error instanceof ReviewCancelledError) {
      recordDecision(error instanceof StaleAuthorizationError ? "stale_authorization" : "cancelled", reason);
      return { block: true, reason };
    }
    if (config?.failurePolicy === "deny" && !(error instanceof ManualTakeoverError)) {
      recordDecision("review_unavailable", reason);
      return { block: true, reason: `Automatic review unavailable: ${reason}` };
    }
    if (ctx.hasUI) {
      try {
        const approved = await requestApproval(event, ctx, "Automatic review unavailable", reason, { ...options, config, currentConfig: options.currentConfig ?? (options.config ? () => options.config! : loadConfig) });
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
  omp.registerShortcut("ctrl+alt+a", { description: "Stop permission review and approve manually", handler: (ctx) => { cancelReviews(ctx, true); } });
  omp.registerShortcut("ctrl+alt+x", { description: "Cancel permission review and block the call", handler: (ctx) => { cancelReviews(ctx); } });
  omp.on("session_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("session_switch", (_event, ctx) => { sessionApprovals.revoke(ctx); cancelReviews(ctx); });
  omp.on("session_shutdown", (_event, ctx) => { sessionApprovals.revoke(ctx); cancelReviews(ctx); });
  omp.on("before_agent_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("turn_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
}
