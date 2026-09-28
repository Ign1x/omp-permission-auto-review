import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { handlerBudgetMs } from "./timing.ts";

// Run before tool_call dispatch: OMP captures the budget before invoking handlers.
// Override only this session's runtime settings, never managed/user config files.
export function syncHandlerBudget(ctx: ExtensionContext, config = loadConfig()): void {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) return;
  ensureHandlerBudget(settings, config);
}

export function ensureHandlerBudget(
  settings: NonNullable<ReturnType<typeof findScopedSettings>>,
  config: Config,
): void {
  const configured = cfgExtensionHandlersToolCallTimeoutMs.get(settings);
  const current = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  const required = handlerBudgetMs(config);
  if (current < required) cfgExtensionHandlersToolCallTimeoutMs.override(settings, required);
}
