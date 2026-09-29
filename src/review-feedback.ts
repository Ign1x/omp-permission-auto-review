import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import { reviewBudgetMs } from "./timing.ts";

// Status reporting must never change the permission decision or break headless callers.
export function status(ctx: ExtensionContext, key: string, message?: string): void {
  if (!ctx.hasUI) return;
  try { ctx.ui.setStatus(key, message); } catch { /* Older/custom UI may omit status support. */ }
}

export function compact(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** One independent status per in-flight review, cleaned up on every exit path. */
export function reviewProgress(event: ToolCallEvent, ctx: ExtensionContext, config: Config, model: string) {
  const key = `permission-review:${event.toolCallId}`;
  const started = performance.now();
  let phase = "Preparing review";
  const render = () => status(ctx, key,
    `${compact(event.toolName)}: ${phase} · ${compact(model)} · ${Math.floor((performance.now() - started) / 1000)}s elapsed / ${Math.ceil(reviewBudgetMs(config) / 1000)}s maximum · Ctrl+Alt+A: approve manually / Ctrl+Alt+X: cancel`,
  );
  const timer = ctx.hasUI ? setInterval(render, 1000) : undefined;
  return {
    attempt(number: number) { phase = `Reviewing (${number}/${config.maxRetries + 1})`; render(); },
    retry(number: number) { phase = `Waiting to retry (${number}/${config.maxRetries + 1})`; render(); },
    stop() { clearInterval(timer); status(ctx, key); },
  };
}

const OUTCOMES: Record<string, string> = {
  baseline_allow: "Allowed locally",
  policy_allow: "Allowed by policy",
  policy_deny: "Blocked by policy",
  allow: "Allowed by reviewer",
  deny: "Denied by reviewer",
  user_allow: "Approved by you",
  user_deny: "Approval not granted",
  user_allow_unavailable: "Approved by you; reviewer unavailable",
  user_deny_unavailable: "Approval not granted; reviewer unavailable",
  session_allow: "Allowed by session approval",
  stale_authorization: "Blocked; authorization changed",
  cancelled: "Review cancelled",
  review_unavailable: "Blocked; reviewer unavailable",
  approval_unavailable: "Blocked; approval dialog unavailable",
};

export function decisionFeedback(ctx: ExtensionContext, event: ToolCallEvent, outcome: string, detail: string): void {
  status(ctx, "permission", `Last permission: ${OUTCOMES[outcome] ?? outcome}: ${compact(event.toolName)} · ${compact(detail)}`);
  if (ctx.hasUI && (outcome === "deny" || outcome === "policy_deny")) {
    try { ctx.ui.notify(`${OUTCOMES[outcome]}: ${compact(event.toolName)}\n${detail}`, "warning"); } catch { /* UI is best effort. */ }
  }
}
