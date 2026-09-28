import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSimple, type Effort } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { configPath, loadConfig, type Config } from "./config.ts";
import { registerPermissionCommand } from "./permission-command.ts";
import { syncHandlerBudget } from "./handler-budget.ts";
import { RETRY_DELAY_MS, seconds } from "./timing.ts";
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

export async function modelReview(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  config: Config,
  complete: typeof completeSimple = completeSimple,
): Promise<Decision> {
  const evidence = reviewEvidence(event, ctx, config);
  const model = config.model === "current" ? ctx.model : ctx.models.resolve(config.model);
  if (!model) throw new Error(`review model is unavailable: ${config.model}`);
  const startedAt = performance.now();
  const modelName = `${model.provider}/${model.id}`;
  const maxAttempts = config.maxRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Each attempt gets its own deadline and cancellation signal, including auth.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`reviewer timed out after ${seconds(config.timeoutMs)}`);
        reject(error);
        controller.abort(error);
      }, config.timeoutMs);
    });
    let failure: unknown;
    try {
      const review = async (): Promise<Decision> => {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        controller.signal.throwIfAborted();
        if (!auth.ok) throw new PermanentReviewError(`review model authentication failed: ${auth.error}`);
        const result = await complete(model, {
          systemPrompt: [REVIEWER_SYSTEM_PROMPT],
          messages: [{ role: "user", content: evidence, timestamp: Date.now() }],
        }, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
          maxTokens: config.maxTokens,
          ...(model.reasoning ? { reasoning: config.reasoning as Effort } : {}),
        });
        controller.signal.throwIfAborted();
        if (result.stopReason === "stop") {
          const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          // All valid decisions are final, including deny and defer.
          return parseDecision(text);
        }
        const status = result.errorStatus;
        const detail = result.errorMessage?.replace(/\s+/g, " ").slice(0, 300);
        const reason = `reviewer stopped: ${result.stopReason}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`;
        if (status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status)) {
          throw new PermanentReviewError(reason);
        }
        throw new Error(reason);
      };
      return await Promise.race([review(), deadline]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer!);
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    if (failure instanceof PermanentReviewError || attempt === maxAttempts) {
      throw new Error(`reviewer unavailable after ${attempt} attempt(s) (model: ${modelName}, elapsed: ${seconds(performance.now() - startedAt)}): ${reason}`);
    }
    if (ctx.hasUI) {
      ctx.ui.notify(`Review attempt ${attempt}/${maxAttempts} failed: ${reason}\nRetrying in ${seconds(RETRY_DELAY_MS)} (${attempt}/${config.maxRetries} retries).`, "warning");
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  throw new Error("reviewer retry exhausted");
}

class PermanentReviewError extends Error {}

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
  let config: Config | undefined;
  const recordDecision = (outcome: string, detail: string) => {
    if (config?.auditLog !== false) record(event, outcome, detail);
  };
  try {
    config = options.config ?? loadConfig();
    const policy = Object.hasOwn(config.toolRules, event.toolName) ? config.toolRules[event.toolName] : config.mode;
    if (policy === "allow" || policy === "yolo") {
      recordDecision("policy_allow", policy);
      return undefined;
    }
    if (policy === "deny") {
      recordDecision("policy_deny", policy);
      return { block: true, reason: `Permission rule denies ${event.toolName}` };
    }
    if (policy === "ask") {
      const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
      const approved = ctx.hasUI && await ctx.ui.confirm("Permission required", `${call}\n\nApprove this call?`);
      recordDecision(approved ? "user_allow" : "user_deny", "ask policy");
      return approved ? undefined : { block: true, reason: `Permission approval required for ${event.toolName}` };
    }
    const decision = await (options.review ?? modelReview)(event, ctx, config);
    if (mayAutoApprove(decision)) {
      recordDecision("allow", decision.rationale);
      return undefined;
    }
    if (decision.outcome === "deny" || decision.risk_level === "critical") {
      recordDecision("deny", decision.rationale);
      return { block: true, reason: `Automatic review denied: ${decision.rationale}` };
    }
    const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
    if (ctx.hasUI && await ctx.ui.confirm("Permission review", `${decision.rationale}\n\n${call}\n\nApprove this call?`)) {
      recordDecision("user_allow", decision.rationale);
      return undefined;
    }
    recordDecision("user_deny", decision.rationale);
    return { block: true, reason: `Permission review requires user approval: ${decision.rationale}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (config?.failurePolicy === "deny") {
      recordDecision("review_unavailable", reason);
      return { block: true, reason: `Automatic review unavailable: ${reason}` };
    }
    if (ctx.hasUI) {
      const call = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
      try {
        const approved = await ctx.ui.confirm("Automatic review unavailable", `${reason}\n\n${call}\n\nApprove this call?`);
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
  omp.on("session_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("before_agent_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("turn_start", (_event, ctx) => syncHandlerBudget(ctx));
  omp.on("tool_call", (event, ctx) => handleToolCall(event, ctx));
}
