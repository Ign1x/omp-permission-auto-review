import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { compact } from "./review-feedback.ts";
import { fingerprint } from "./session-approvals.ts";

interface Record { time: string; tool: string; outcome: string; reason: string; elapsedMs: number; inputFingerprint: string }
const histories = new Map<string, Record[]>();
export function recordDiagnostic(ctx: ExtensionContext, event: ToolCallEvent, outcome: string, reason: string, elapsedMs: number): void {
  const id = ctx.sessionManager?.getSessionId?.();
  if (!id) return;
  if (!histories.has(id) && histories.size >= 100) histories.delete(histories.keys().next().value!);
  const history = histories.get(id) ?? [];
  history.push({ time: new Date().toISOString(), tool: event.toolName, outcome, reason: compact(reason), elapsedMs: Math.round(elapsedMs), inputFingerprint: fingerprint([event.toolName, event.input]) });
  if (history.length > 50) history.shift();
  histories.set(id, history);
}
export function diagnosticHistory(ctx: ExtensionContext): string {
  const history = histories.get(ctx.sessionManager?.getSessionId?.() ?? "") ?? [];
  const counts: { [key: string]: number } = {};
  for (const item of history) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return JSON.stringify({ retained: history.length, outcomes: counts, recent: history }, null, 2);
}
