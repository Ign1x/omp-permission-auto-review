import type { Config } from "./config.ts";

export const RETRY_DELAY_MS = 1000;

export function reviewBudgetMs(config: Config): number {
  return config.timeoutMs * (config.maxRetries + 1) + RETRY_DELAY_MS * config.maxRetries;
}

export function handlerBudgetMs(config: Config): number {
  return reviewBudgetMs(config) + 5000;
}

export function seconds(milliseconds: number): string {
  const value = Number((milliseconds / 1000).toFixed(3));
  return `${value} ${value === 1 ? "second" : "seconds"}`;
}

export function parseTimeoutSeconds(value: string): number {
  if (!/^\d+(?:\.\d{1,3})?s?$/.test(value)) {
    throw new Error("timeout must be in seconds, e.g. 60 or 60s (up to 300 seconds)");
  }
  const milliseconds = Math.round(Number(value.replace(/s$/, "")) * 1000);
  if (milliseconds <= 0 || milliseconds > 300000) {
    throw new Error("timeout must be greater than 0 and at most 300 seconds; use 60 for one minute");
  }
  return milliseconds;
}
