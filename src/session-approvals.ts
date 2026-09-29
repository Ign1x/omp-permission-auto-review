import { createHash } from "node:crypto";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import type { ToolAction } from "./policy.ts";
import { canonicalCwd } from "./scoped-rules.ts";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
export function policyFingerprint(config: Config): string { return fingerprint(config); }

function sessionKey(ctx: ExtensionContext): string | undefined {
  const id = ctx.sessionManager?.getSessionId?.();
  return id ? `${id}:${ctx.agent?.kind ?? "main"}:${ctx.agent?.id ?? "main"}` : undefined;
}

export interface SessionGrant { id: string; tool: string; createdAt: string }
interface State { policy: string; grants: Map<string, SessionGrant> }
export class SessionApprovals {
  private sessions = new Map<string, State>();
  private state(ctx: ExtensionContext, config: Config): State | undefined {
    const key = sessionKey(ctx);
    if (!key) return;
    const policy = policyFingerprint(config);
    let state = this.sessions.get(key);
    if (state?.policy !== policy) {
      state = { policy, grants: new Map() };
      if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(key, state);
    }
    return state;
  }
  key(event: ToolAction, ctx: ExtensionContext): string | undefined {
    const cwd = canonicalCwd(ctx.cwd);
    return cwd && sessionKey(ctx) ? fingerprint({ cwd, tool: event.toolName, input: event.input }) : undefined;
  }
  has(event: ToolAction, ctx: ExtensionContext, config: Config): boolean {
    const key = this.key(event, ctx);
    return !!key && !!this.state(ctx, config)?.grants.has(key);
  }
  grant(event: ToolAction, ctx: ExtensionContext, config: Config): boolean {
    const key = this.key(event, ctx), state = this.state(ctx, config);
    if (!key || !state) return false;
    if (state.grants.size >= 256) state.grants.delete(state.grants.keys().next().value!);
    state.grants.set(key, { id: key, tool: event.toolName, createdAt: new Date().toISOString() });
    return true;
  }
  list(ctx: ExtensionContext, config: Config): SessionGrant[] { return [...(this.state(ctx, config)?.grants.values() ?? [])]; }
  revoke(ctx: ExtensionContext, id?: string): void {
    const key = sessionKey(ctx);
    if (!key) return;
    if (id) this.sessions.get(key)?.grants.delete(id);
    else this.sessions.delete(key);
  }
}
export const sessionApprovals = new SessionApprovals();
