import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export interface Config {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxInputCharacters: number;
}

export const DEFAULT_CONFIG: Config = {
  model: "current",
  maxTokens: 4096,
  timeoutMs: 60000,
  maxInputCharacters: 12000,
};

export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", "omp-permission-auto-review", "config.json");
}

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`unknown config key: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...input } as Config;
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("model must be a non-empty string");
  for (const key of ["maxTokens", "timeoutMs", "maxInputCharacters"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (config.maxTokens > 16384 || config.maxInputCharacters > 100000 || config.timeoutMs > 300000) {
    throw new Error("config exceeds supported limits");
  }
  return config;
}

export function loadConfig(path = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error;
  }
  return parseConfig(JSON.parse(raw));
}
