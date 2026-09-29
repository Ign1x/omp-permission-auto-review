import { afterEach, describe, expect, jest, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { modelReview, handleToolCall } from "../src/index.ts";
import { requestApproval } from "../src/approval.ts";
import { cancelReviews } from "../src/review-control.ts";
import { diagnosticHistory } from "../src/diagnostics.ts";

const decision = { outcome: "allow", risk_level: "low", user_authorization: "high", rationale: "Requested" } as const;
const response = () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(decision) }] });
const event = { type: "tool_call", toolName: "bash", toolCallId: "feedback", input: { command: "git status" } } as const;
function fixture() {
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  const ctx = { cwd: "/tmp", agent: { kind: "main", id: "Main" }, hasUI: true,
    sessionManager: { getSessionId: () => "feedback", getBranch: () => [{ type: "message", message: { role: "user", content: "Inspect" } }] },
    model: { id: "reviewer", provider: "fixture" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    ui: { setStatus: (key: string, value?: string) => value === undefined ? statuses.delete(key) : statuses.set(key, value), notify: (s: string) => notifications.push(s), confirm: async () => false },
  } as any;
  return { ctx, statuses, notifications };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
afterEach(() => jest.useRealTimers());
describe("permission feedback", () => {
  test("reports model, attempt, retry, elapsed time and total budget, with cleanup", async () => {
    jest.useFakeTimers();
    const { ctx, statuses } = fixture();
    let attempts = 0;
    let finish!: (v: unknown) => void;
    const pending = modelReview(event as any, ctx, DEFAULT_CONFIG, (async () => {
      if (++attempts === 1) throw new Error("offline");
      return new Promise((r) => { finish = r; });
    }) as any);
    expect(statuses.get("permission-review:feedback")).toContain("Reviewing (1/3)");
    expect(statuses.get("permission-review:feedback")).toContain("fixture/reviewer");
    await settle();
    expect(statuses.get("permission-review:feedback")).toContain("Waiting to retry (2/3)");
    jest.advanceTimersByTime(1000); await settle();
    expect(statuses.get("permission-review:feedback")).toContain("Reviewing (2/3)");
    jest.advanceTimersByTime(1000); await settle();
    expect(statuses.get("permission-review:feedback")).toContain("2s elapsed / 20s maximum");
    finish(response()); expect(await pending).toEqual(decision);
    expect(statuses.has("permission-review:feedback")).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  test("manual takeover cancels provider work, clears progress and asks once", async () => {
    const { ctx, statuses } = fixture();
    let signal!: AbortSignal;
    let prompts = 0;
    ctx.ui.confirm = async () => {
      prompts++;
      expect(statuses.has("permission-review:feedback")).toBe(false);
      expect(statuses.get("permission")).toContain("Waiting for your approval");
      return true;
    };
    const pending = handleToolCall(event as any, ctx, {
      config: { ...DEFAULT_CONFIG, failurePolicy: "deny" }, record: () => {},
      review: (e, c, config, external) => modelReview(e, c, config, (async (_m: any, _c: any, o: any) => { signal = o.signal; return new Promise(() => {}); }) as any, { signal: external }),
    });
    await settle(); expect(cancelReviews(ctx, true)).toBe(1);
    expect(await pending).toBeUndefined(); expect(signal.aborted).toBe(true); expect(prompts).toBe(1);
  });
  test("denial and provider failure have distinct feedback and private session diagnostics", async () => {
    const { ctx, statuses, notifications } = fixture();
    await handleToolCall(event as any, ctx, { config: DEFAULT_CONFIG, record: () => {}, review: async () => ({ ...decision, outcome: "deny" }) });
    expect(notifications.at(-1)).toContain("Denied by reviewer");
    await handleToolCall(event as any, ctx, { config: { ...DEFAULT_CONFIG, failurePolicy: "deny" }, record: () => {}, review: async () => { throw new Error("HTTP 503"); } });
    expect(statuses.get("permission")).toContain("Blocked; reviewer unavailable");
    const history = JSON.parse(diagnosticHistory(ctx));
    expect(history.outcomes.deny).toBeGreaterThan(0);
    expect(history.recent.at(-1).elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(history)).not.toContain("git status");
  });
  test("full input can be inspected and cancelling the turn never approves", async () => {
    const { ctx } = fixture();
    const choices = ["Show full input", "Back", "Cancel turn"];
    const titles: string[] = [];
    let aborted = false;
    ctx.abort = () => { aborted = true; };
    ctx.ui.select = async (title: string) => { titles.push(title); return choices.shift(); };
    expect(await requestApproval(event as any, ctx, "Permission", "Review needed", { config: DEFAULT_CONFIG })).toBe(false);
    expect(titles[1]).toContain('"command": "git status"');
    expect(aborted).toBe(true);
  });
  test("concurrent reviews own separate progress indicators", async () => {
    const { ctx, statuses } = fixture();
    const finishes: Array<(v: unknown) => void> = [];
    const complete = (async () => new Promise((r) => finishes.push(r))) as any;
    const one = modelReview(event as any, ctx, DEFAULT_CONFIG, complete);
    const two = modelReview({ ...event, toolCallId: "second" } as any, ctx, DEFAULT_CONFIG, complete);
    await settle(); finishes[0](response()); await one;
    expect(statuses.has("permission-review:second")).toBe(true);
    finishes[1](response()); await two;
    expect(statuses.size).toBe(0);
  });
});
