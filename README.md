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
covers review mode, reviewer model, failure handling, timeout, token/input
limits, audit logging, and exact tool-name rules. The same settings can be
changed directly:

```text
/permission show
/permission path
/permission mode review|ask|deny|yolo
/permission fallback ask|deny
/permission model current|provider/model
/permission timeout 20000
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
in headless mode. Transient reviewer errors are retried once within the review
timeout. The timeout is capped at 25 seconds to stay within OMP's 30-second
extension handler limit.
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
