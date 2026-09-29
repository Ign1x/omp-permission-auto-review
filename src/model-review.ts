import { completeSimple, type Effort } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import { RETRY_DELAY_MS, reviewBudgetMs, seconds } from "./timing.ts";
import { abortable, abortableDelay, ReviewCancelledError, ManualTakeoverError } from "./review-control.ts";
import { parseDecision, REVIEWER_SYSTEM_PROMPT, type Decision } from "./review.ts";

import { reviewEvidence, authorizationRevision, StaleAuthorizationError } from "./evidence.ts";
export { reviewEvidence } from "./evidence.ts";

export async function modelReview(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  config: Config,
  complete: typeof completeSimple = completeSimple,
  control: { signal?: AbortSignal; progress?: (attempt: number, phase: "reviewing" | "retrying") => void } = {},
): Promise<Decision> {
  const revision = authorizationRevision(ctx);
  const model = config.model === "current" ? ctx.model : ctx.models.resolve(config.model);
  if (!model) throw new Error(`review model is unavailable: ${config.model}`);
  const startedAt = performance.now();
  const modelName = `${model.provider}/${model.id}`;
  const maxAttempts = config.maxRetries + 1;
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new Error(`total review budget exhausted after ${seconds(reviewBudgetMs(config))}`)), reviewBudgetMs(config));
  const forward = () => total.abort(control.signal?.reason ?? new ReviewCancelledError());
  control.signal?.addEventListener("abort", forward, { once: true });
  if (control.signal?.aborted) forward();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      total.signal.throwIfAborted();
      control.progress?.(attempt, "reviewing");
      if (authorizationRevision(ctx) !== revision) throw new StaleAuthorizationError();
      const evidence = reviewEvidence(event, ctx, config);
      // Each attempt gets its own deadline and cancellation signal, including auth.
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, total.signal]);
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
          signal.throwIfAborted();
          if (!auth.ok) throw new PermanentReviewError(`review model authentication failed: ${auth.error}`);
          const result = await complete(model, {
            systemPrompt: [REVIEWER_SYSTEM_PROMPT],
            messages: [{ role: "user", content: evidence, timestamp: Date.now() }],
          }, {
            apiKey: auth.apiKey,
            headers: auth.headers,
            signal,
            maxTokens: config.maxTokens,
            ...(model.reasoning ? { reasoning: config.reasoning as Effort } : {}),
          });
          signal.throwIfAborted();
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
        const decision = await abortable(Promise.race([review(), deadline]), total.signal);
        if (authorizationRevision(ctx) !== revision) throw new StaleAuthorizationError();
        return decision;
      } catch (error) {
        if (error instanceof StaleAuthorizationError || error instanceof ReviewCancelledError || error instanceof ManualTakeoverError) throw error;
        failure = error;
      } finally {
        clearTimeout(timer!);
      }
      const reason = failure instanceof Error ? failure.message : String(failure);
      if (total.signal.aborted || failure instanceof PermanentReviewError || attempt === maxAttempts) {
        throw new Error(`reviewer unavailable after ${attempt} attempt(s) (model: ${modelName}, elapsed: ${seconds(performance.now() - startedAt)}): ${reason}`);
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`Review attempt ${attempt}/${maxAttempts} failed: ${reason}\nRetrying in ${seconds(RETRY_DELAY_MS)} (${attempt}/${config.maxRetries} retries).`, "warning");
      }
      control.progress?.(attempt + 1, "retrying");
      await abortableDelay(RETRY_DELAY_MS, total.signal);
    }
    throw new Error("reviewer retry exhausted");
  } finally {
    clearTimeout(totalTimer);
    control.signal?.removeEventListener("abort", forward);
  }
}

class PermanentReviewError extends Error {}
