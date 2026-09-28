import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { ensureHandlerBudget } from "../src/handler-budget.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { handlerBudgetMs, reviewBudgetMs } from "../src/timing.ts";

describe("OMP retry budget", () => {
  test("covers every attempt, retry delay and fallback without saving config", () => {
    const settings = Settings.isolated();
    const config = { ...DEFAULT_CONFIG, timeoutMs: 120000, maxRetries: 2 };
    expect(reviewBudgetMs(config)).toBe(362000);
    expect(handlerBudgetMs(config)).toBe(367000);
    ensureHandlerBudget(settings, config);
    expect(cfgExtensionHandlersToolCallTimeoutMs.get(settings)).toBe(367000);
    expect(settings.getProvenance(cfgExtensionHandlersToolCallTimeoutMs)).toBe("runtime");
    expect(settings.getGlobalSettings()).toEqual({});
  });

  test("does not reduce a larger handler budget or affect other sessions", () => {
    const settings = Settings.isolated();
    const other = Settings.isolated();
    cfgExtensionHandlersToolCallTimeoutMs.override(settings, 400000);
    ensureHandlerBudget(settings, DEFAULT_CONFIG);
    expect(cfgExtensionHandlersToolCallTimeoutMs.get(settings)).toBe(400000);
    expect(cfgExtensionHandlersToolCallTimeoutMs.get(other)).toBe(30000);
  });
});
