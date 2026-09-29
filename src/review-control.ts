import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export class ReviewCancelledError extends Error {
  constructor() { super("Permission review cancelled; tool was not executed"); }
}
export class ManualTakeoverError extends Error {
  constructor() { super("Automatic review stopped at your request; manual approval required"); }
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new ReviewCancelledError());
    signal.addEventListener("abort", aborted, { once: true });
    // Attach handlers even when already aborted, so late provider rejection is consumed.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer!); }
}

const active = new Map<string, Set<AbortController>>();
function key(ctx: ExtensionContext): string | undefined { return ctx.sessionManager?.getSessionId?.(); }
export function startReview(ctx: ExtensionContext, external?: AbortSignal) {
  const controller = new AbortController();
  const id = key(ctx);
  if (id) { const set = active.get(id) ?? new Set(); set.add(controller); active.set(id, set); }
  const forward = () => controller.abort(external?.reason instanceof ManualTakeoverError ? external.reason : new ReviewCancelledError());
  external?.addEventListener("abort", forward, { once: true });
  if (external?.aborted) forward();
  return { signal: controller.signal, dispose() {
    external?.removeEventListener("abort", forward);
    if (id) { const set = active.get(id); set?.delete(controller); if (!set?.size) active.delete(id); }
  } };
}
export function cancelReviews(ctx: ExtensionContext, manual = false): number {
  const controllers = active.get(key(ctx) ?? "");
  let count = 0;
  for (const controller of controllers ?? []) if (!controller.signal.aborted) {
    controller.abort(manual ? new ManualTakeoverError() : new ReviewCancelledError()); count++;
  }
  return count;
}
