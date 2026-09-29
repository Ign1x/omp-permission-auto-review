import type { Config } from "./config.ts";
import { matchBaselineRule } from "./baseline-rules.ts";

export interface ToolAction {
  toolName: string;
  input: unknown;
}

export interface PolicyDecision {
  action: "allow" | "deny" | "ask" | "review";
  source: "tool-rule" | "mode" | "baseline";
  reason: string;
  ruleId?: string;
}

/** Local policy never contacts a provider or prompts the user. */
export function evaluatePolicy(event: ToolAction, cwd: string, config: Config): PolicyDecision {
  if (Object.hasOwn(config.toolRules, event.toolName)) {
    const action = config.toolRules[event.toolName]!;
    return { action, source: "tool-rule", reason: `Explicit ${event.toolName} rule: ${action}` };
  }
  if (config.mode !== "review") {
    return { action: config.mode === "yolo" ? "allow" : config.mode, source: "mode", reason: `Permission mode: ${config.mode}` };
  }
  const baseline = config.baselineRules && matchBaselineRule(event.toolName, event.input, cwd);
  if (baseline) return { action: "allow", source: "baseline", reason: baseline.description, ruleId: baseline.id };
  return { action: "review", source: "mode", reason: "No local permission rule covers this action" };
}
