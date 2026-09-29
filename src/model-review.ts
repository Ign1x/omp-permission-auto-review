import { completeSimple, type Effort } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import { RETRY_DELAY_MS, seconds } from "./timing.ts";
import { parseDecision, REVIEWER_SYSTEM_PROMPT, type Decision } from "./review.ts";

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

