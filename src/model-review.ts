import { INSPECT_TOOL, inspectPath } from "./review-inspection.ts";
import { completeSimple, type Effort, type Message } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import { RETRY_DELAY_MS, reviewBudgetMs, seconds } from "./timing.ts";
import { abortable, abortableDelay, ReviewCancelledError, ManualTakeoverError } from "./review-control.ts";
import { reviewProgress } from "./review-feedback.ts";
import { parseGuardianAssessment, REVIEWER_SYSTEM_PROMPT, type Decision } from "./review.ts";

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
  let inspections = 0;
  const progress = reviewProgress(event, ctx, config, modelName);
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new Error(`total review budget exhausted after ${seconds(reviewBudgetMs(config))}`)), reviewBudgetMs(config));
  const forward = () => total.abort(control.signal?.reason ?? new ReviewCancelledError());
  control.signal?.addEventListener("abort", forward, { once: true });
  if (control.signal?.aborted) forward();
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      total.signal.throwIfAborted();
      control.progress?.(attempt, "reviewing");
      progress.attempt(attempt);
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
          const messages: Message[] = [{ role: "user", content: evidence, timestamp: Date.now() }];
          for (;;) {
            signal.throwIfAborted();
            if (authorizationRevision(ctx) !== revision) throw new StaleAuthorizationError();
            const result = await complete(model, {
              systemPrompt: [REVIEWER_SYSTEM_PROMPT], messages, tools: [INSPECT_TOOL],
            }, {
              apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens: config.maxTokens,
              ...(model.reasoning ? { reasoning: config.reasoning as Effort } : {}),
            });
            signal.throwIfAborted();
            if (authorizationRevision(ctx) !== revision) throw new StaleAuthorizationError();
            if (result.stopReason === "stop") {
              const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
              return parseGuardianAssessment(text);
            }
            if (result.stopReason === "toolUse") {
              const calls = result.content.filter((part) => part.type === "toolCall");
              if (!calls.length || inspections + calls.length > 4) throw new PermanentReviewError("review inspection limit reached");
              messages.push(result);
              for (const call of calls) {
                inspections++;
                signal.throwIfAborted();
                const remaining = config.maxInputCharacters - Buffer.byteLength(JSON.stringify(messages), "utf8") - 500;
                if (remaining < 1000) throw new PermanentReviewError("review inspection context budget exhausted");
                const output = call.name === "inspect_path"
                  ? await abortable(inspectPath(call.arguments, ctx.cwd, signal, Math.min(remaining, 6000)), signal)
                  : JSON.stringify({ error: "Only inspect_path is available; commands and writes are not permitted" });
                const message: Message = { role: "toolResult", toolCallId: call.id, toolName: call.name,
                  content: [{ type: "text", text: output }], isError: false, timestamp: Date.now() };
                if (Buffer.byteLength(JSON.stringify([...messages, message]), "utf8") > config.maxInputCharacters) throw new PermanentReviewError("review inspection context budget exhausted");
                messages.push(message);
              }
              continue;
            }
            const status = result.errorStatus;
            const detail = result.errorMessage?.replace(/\s+/g, " ").slice(0, 300);
            const reason = `reviewer stopped: ${result.stopReason}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`;
            if (status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status)) {
              throw new PermanentReviewError(reason);
            }
            throw new Error(reason);
          }
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
      progress.retry(attempt + 1);
      await abortableDelay(RETRY_DELAY_MS, total.signal);
    }
    throw new Error("reviewer retry exhausted");
  } finally {
    progress.stop();
    clearTimeout(totalTimer);
    control.signal?.removeEventListener("abort", forward);
  }
}

class PermanentReviewError extends Error {}
