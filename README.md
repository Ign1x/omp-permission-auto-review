# omp-permission-auto-review

A single OMP extension that reviews tool calls with a model before execution.
It combines permission interception and automatic review in one `tool_call`
handler, so no cross-extension authorizer registration is required.

## Status

Designed for Oh My Pi 18.3.2. This is an early OMP-specific adaptation; it is
not a drop-in replacement for every policy, sandbox broker, or permission
surface supported by the upstream projects. It covers OMP tool calls. OMP's
native approval gate may still apply unless `tools.approvalMode` is `yolo`.

## Install

```sh
omp plugin link /path/to/omp-permission-auto-review
```

Disable `@gotgenes/pi-permission-system` and `@erichll/pi-auto-review` in OMP
before using this extension, so each call is reviewed once. For the extension
to own tool approval, set `tools.approvalMode: yolo` in OMP's `config.yml`.
The extension asks for manual approval when review fails in an interactive
session, and blocks when no UI is available or the reviewer denies the call.

The optional configuration file is
`~/.omp/agent/extensions/omp-permission-auto-review/config.json`, or the same
path under the active OMP profile's agent directory:

```json
{
  "model": "gateway/deepseek-v4.1-flash",
  "maxTokens": 4096,
  "timeoutMs": 20000,
  "maxRetries": 2,
  "reasoning": "low",
  "maxInputCharacters": 12000,
  "mode": "review",
  "failurePolicy": "ask",
  "auditLog": true,
  "toolRules": {}
}
```

## `/permission` settings

Run `/permission` in OMP's interactive TUI to edit settings. Changes take
effect on the next tool call, including in other running sessions. The menu
covers review mode, reviewer model, thinking effort, retries, failure handling,
timeout in seconds, token/input
limits, audit logging, and exact tool-name rules. The same settings can be
changed directly:

```text
/permission show
/permission path
/permission mode review|ask|deny|yolo
/permission fallback ask|deny
/permission model current|provider/model
/permission timeout 20
/permission retries 2
/permission thinking low
/permission max-tokens 4096
/permission max-input 12000
/permission audit on|off
/permission rule bash ask
/permission rule edit deny
/permission rule remove bash
/permission reset
```

`review` uses the model; `ask` always prompts; `deny` blocks; `yolo` runs tools
without review. A tool rule overrides the global mode for that exact tool name.
Tool rules accept `review`, `ask`, `allow`, or `deny`; they do not match shell
command text or paths. When the reviewer is unavailable, `fallback ask` prompts
in an interactive session and blocks without UI. `fallback deny` always blocks.
Explicit reviewer denials still block under either fallback policy.

`config.json` can be managed by Nix or another tool. `/permission` never writes
to it. Changes are stored with mode `0600` in a separate `user.json` beside it;
user settings override managed defaults. `/permission path` shows both paths,
and `/permission reset` removes only `user.json`.

With no file, `model` defaults to `current`, using the active OMP model and
its credentials. The reviewer receives the exact tool input and up to three
recent user-authored messages. Subagent task messages are included separately
as untrusted context, not as evidence of user authorization. An oversized
request, invalid configuration, missing credentials, timeout, or malformed
reviewer output asks for manual approval in an interactive session and blocks
in headless mode.

Thinking stays enabled for reasoning-capable models, with `low` requested by
default. `/permission thinking low|medium|high` changes the requested effort;
actual support depends on the model/provider. Non-reasoning models omit the effort.

The default is **2 retries after the first attempt**, for up to 3 attempts.
`/permission retries 0` disables retries; supported values are 0–5. Each attempt
gets its own full timeout and cancellation signal, including authentication.
An attempt is one reviewer SDK call; any SDK-internal transport retries share
that attempt's timeout rather than starting a new budget.
Timeouts, provider aborts, connection failures, HTTP 408/429/5xx and missing,
truncated or invalid decisions are retried, with a 1-second delay between attempts.
A valid `allow`, `deny` or `defer` ends review immediately. A denial is never retried
or converted to manual approval. Invalid configuration, missing credentials and
other HTTP 4xx errors fail immediately because repeating the request cannot fix
them. Exhausted retries use the configured failure policy (default: ask).

The timeout menu, command, notices and diagnostics use **seconds**. For example,
`/permission timeout 60` or `/permission timeout 60s` gives every attempt 60 seconds.
The supported range is greater than 0 and at most 300 seconds. Existing JSON files
keep their `timeoutMs` field unchanged for compatibility; old command values such
as `/permission timeout 60000` are rejected with a seconds-specific hint.

With a 60-second timeout and 2 retries, the maximum review wait is 182 seconds:
3 attempts × 60 seconds + 2 retry delays × 1 second. `/permission show` displays
both this total and the required OMP handler budget, including 5 seconds of margin.
The extension raises `extensionHandlers.toolCallTimeoutMs` in the active session
before tool dispatch (on session start, agent start, and each turn), and after
`/permission` commands. This runtime override never lowers a larger budget or
writes to managed/user OMP configuration. Changes from other sessions are picked
up at the next turn; an already running review keeps its original configuration.
Time awaiting OMP's manual approval dialog does not count against the handler budget.

Timeouts are bounded even when the provider does not settle after cancellation.
Late responses from expired attempts cannot approve the tool. Final error messages
include the attempt count, model, elapsed seconds, and last failure; retry notices
show progress. After upgrading the extension, **restart OMP** to replace code already
loaded in running sessions.

Requests labeled `defer`, and high-risk allows without enough user
authorization, ask the user in an interactive session and block in headless
mode. Critical-risk decisions always deny.

When `auditLog` is on, review records are written to
`~/.omp/agent/extensions/omp-permission-auto-review/logs/review.jsonl` (or
the active profile equivalent). They contain a SHA-256 fingerprint of the
tool input, the outcome, and a short rationale; they do not contain raw tool
arguments. The reviewer request itself does contain the arguments and recent
user text, so choose a model/provider accordingly.

## Development

```sh
bun install
bun run check
bun test
```

## Origins and license

Most of the permission and reviewer policy design, the reviewer prompt, and
strict decision parsing are adapted from
[`@erichll/pi-auto-review`](https://github.com/erichll/pi-packages/tree/main/packages/pi-auto-review)
(version 0.21.0, MIT). The permission boundary and fail-closed design draw on
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
(version 34.0.1, MIT). The OMP event integration and package wiring are new.
This project is MIT licensed. Original upstream notices are reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
