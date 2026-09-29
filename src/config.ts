import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { validateScopedRules, type ScopedRule } from "./scoped-rules.ts";

export type Mode = "review" | "ask" | "deny" | "yolo";
export type ToolPolicy = "review" | "ask" | "allow" | "deny";
export type FailurePolicy = "ask" | "deny";
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface Config {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  reviewTimeoutMs: number;
  maxRetries: number;
  reasoning: ThinkingLevel;
  maxInputCharacters: number;
  mode: Mode;
  failurePolicy: FailurePolicy;
  auditLog: boolean;
  baselineRules: boolean;
  toolRules: Partial<Record<string, ToolPolicy>>;
  scopedRules: ScopedRule[];
}

export const DEFAULT_CONFIG: Config = {
  model: "current",
  maxTokens: 4096,
  timeoutMs: 20000,
  reviewTimeoutMs: 20000,
  maxRetries: 2,
  reasoning: "low",
  maxInputCharacters: 12000,
  mode: "review",
  failurePolicy: "ask",
  auditLog: true,
  baselineRules: true,
  toolRules: {},
  scopedRules: [],
};

export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", "omp-permission-auto-review", "config.json");
}

export function overrideConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", "omp-permission-auto-review", "user.json");
}

function readConfigFile(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`unknown config key: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...input } as Config;
  validateScopedRules(config.scopedRules);
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("model must be a non-empty string");
  for (const key of ["maxTokens", "timeoutMs", "reviewTimeoutMs", "maxInputCharacters"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (config.maxTokens > 16384 || config.maxInputCharacters > 100000 || config.timeoutMs > 300000 || config.reviewTimeoutMs > 1800000) {
    throw new Error("config exceeds supported limits");
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 5) {
    throw new Error("maxRetries must be an integer from 0 to 5");
  }
  if (!THINKING_LEVELS.includes(config.reasoning)) throw new Error("reasoning must be low, medium, or high");
  if (!["review", "ask", "deny", "yolo"].includes(config.mode)) throw new Error("invalid mode");
  if (!["ask", "deny"].includes(config.failurePolicy)) throw new Error("invalid failurePolicy");
  if (typeof config.auditLog !== "boolean") throw new Error("auditLog must be a boolean");
  if (typeof config.baselineRules !== "boolean") throw new Error("baselineRules must be a boolean");
  if (!config.toolRules || typeof config.toolRules !== "object" || Array.isArray(config.toolRules)) {
    throw new Error("toolRules must be an object");
  }
  for (const [tool, policy] of Object.entries(config.toolRules)) {
    if (!/^[\w.:-]+$/.test(tool) || ["__proto__", "constructor", "prototype"].includes(tool) ||
        !["review", "ask", "allow", "deny"].includes(policy ?? "")) {
      throw new Error(`invalid tool rule: ${tool}`);
    }
  }
  return config;
}

export function loadConfig(basePath = configPath(), userPath = join(dirname(basePath), "user.json")): Config {
  return parseConfig({ ...readConfigFile(basePath), ...readConfigFile(userPath) });
}

export function saveConfig(
  changes: Partial<Config>,
  basePath = configPath(),
  userPath = join(dirname(basePath), "user.json"),
): Config {
  const overrides = { ...readConfigFile(userPath), ...changes };
  const config = parseConfig({ ...readConfigFile(basePath), ...overrides });
  mkdirSync(dirname(userPath), { recursive: true, mode: 0o700 });
  const tempPath = `${userPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tempPath, userPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* The temporary file may not exist. */ }
    throw error;
  }
  return config;
}

export function resetConfig(userPath = overrideConfigPath()): void {
  try {
    unlinkSync(userPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
