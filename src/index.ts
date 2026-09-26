import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { configPath, loadConfig, type Config } from "./config.ts";
import { mayAutoApprove, parseDecision, REVIEWER_SYSTEM_PROMPT, type Decision } from "./review.ts";

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string).join("\n");
}

export function reviewEvidence(event: ToolCallEvent, ctx: ExtensionContext, config: Config): string {
  const messages = ctx.sessionManager.getBranch()
    .flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) return [];
      const text = userText(entry.message.content);
      return text ? [{ attribution: entry.message.attribution, text }] : [];
    });
  const users = messages.filter((message) => message.attribution !== "agent").map((message) => message.text).slice(-3);
  const agentRequests = messages.filter((message) => message.attribution === "agent")
    .map((message) => message.text).slice(-3);
  if (users.length === 0 && (ctx.agent.kind !== "sub" || agentRequests.length === 0)) {
    throw new Error("no reviewable request is available");
  }
  const evidence = JSON.stringify({
    cwd: ctx.cwd,
    agent: ctx.agent,
    tool: event.toolName,
    input: event.input,
    userMessages: users,
    agentRequests,
  });
  if (Buffer.byteLength(evidence, "utf8") > config.maxInputCharacters) {
    throw new Error("review evidence exceeds maxInputCharacters");
  }
  return evidence;
}

export async function modelReview(event: ToolCallEvent, ctx: ExtensionContext, config: Config): Promise<Decision> {
  const evidence = reviewEvidence(event, ctx, config);
  const model = config.model === "current" ? ctx.model : ctx.models.resolve(config.model);
  if (!model) throw new Error(`review model is unavailable: ${config.model}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`review model authentication failed: ${auth.error}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await completeSimple(model, {
      systemPrompt: [REVIEWER_SYSTEM_PROMPT],
      messages: [{ role: "user", content: evidence, timestamp: Date.now() }],
    }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: controller.signal,
      maxTokens: config.maxTokens,
    });
    if (result.stopReason !== "stop") throw new Error(`reviewer stopped: ${result.stopReason}`);
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    return parseDecision(text);
  } finally {
    clearTimeout(timer);
  }
}

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
  let config: Config;
  try {
    config = options.config ?? loadConfig();
    const decision = await (options.review ?? modelReview)(event, ctx, config);
    if (mayAutoApprove(decision)) {
      record(event, "allow", decision.rationale);
      return undefined;
    }
    if (decision.outcome === "deny" || decision.risk_level === "critical") {
      record(event, "deny", decision.rationale);
      return { block: true, reason: `Automatic review denied: ${decision.rationale}` };
    }
    const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
    if (ctx.hasUI && await ctx.ui.confirm("Permission review", `${decision.rationale}\n\n${call}\n\nApprove this call?`)) {
      record(event, "user_allow", decision.rationale);
      return undefined;
    }
    record(event, "user_deny", decision.rationale);
    return { block: true, reason: `Permission review requires user approval: ${decision.rationale}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    record(event, "review_unavailable", reason);
    ctx.ui.notify(`Permission review unavailable: ${reason}`, "error");
    return { block: true, reason: `Automatic review unavailable: ${reason}` };
  }
}

export default function ompPermissionAutoReview(omp: ExtensionAPI): void {
  omp.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
}
