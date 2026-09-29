# omp-permission-auto-review

A single OMP extension that checks tool calls before execution, using a local
allow library for simple queries and a model for the remaining calls.
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
  "reviewTimeoutMs": 20000,
  "maxRetries": 2,
  "reasoning": "low",
  "maxInputCharacters": 12000,
  "mode": "review",
  "failurePolicy": "ask",
  "auditLog": true,
  "baselineRules": true,
  "toolRules": {}
}
```

## `/permission` settings

Run `/permission` in OMP's interactive TUI to edit settings. Changes take
effect on the next tool call, including in other running sessions. The menu
covers review mode, reviewer model, thinking effort, retries, failure handling,
timeout in seconds, token/input
limits, audit logging, baseline rules, and exact tool-name rules. The same settings can be
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
/permission baseline on|off|list
/permission rule bash ask
/permission rule edit deny
/permission rule remove bash
/permission reset
```

`review` checks the baseline library, then uses the model for unmatched calls;
`ask` always prompts; `deny` blocks; `yolo` runs tools
without review. A tool rule overrides the global mode for that exact tool name.
Tool rules accept `review`, `ask`, `allow`, or `deny`; they do not match shell
command text or paths. When the reviewer is unavailable, `fallback ask` prompts
in an interactive session and blocks without UI. `fallback deny` always blocks.
Explicit reviewer denials still block under either fallback policy.

## Baseline allow rules

The built-in library is **enabled by default**, including with existing config
files that omit `baselineRules`. A match skips model requests and manual prompts,
including in headless sessions. It does not require reviewer credentials or
conversation evidence. `/permission baseline off` disables the library;
`/permission baseline list` displays its stable rule IDs and scope.

Precedence is: an exact tool rule, then global mode, then (in global `review`
mode) the baseline library, then model review. An explicit
`/permission rule bash review` always uses the model, even for a baseline match.
Explicit `ask` and `deny` policies also take priority over the library.

The `workspace.read` rule permits ordinary OMP `read` calls for existing files and
directories inside the calling session's working directory, including inline text
selectors such as `src/main.ts:1-100` and `README.md:raw`. It makes no model request
and needs no manual approval. Symlink targets must stay inside the workspace.
URLs, missing/ambiguous paths, globs, multi-file requests, special selectors,
device files and unknown input fields fall through to review. Explicit tool rules
and modes still take precedence. These dispatch-time checks trust OMP's read
implementation; they do not provide an OS sandbox or prevent filesystem races.

The `bash` library covers these commands:

| Rule ID | Accepted scope |
| --- | --- |
| `local.pwd` | No arguments, `-L`, or `-P` |
| `local.ls` | Literal local paths and selected display flags, such as `-la`, `-h`, `--all`, and `--color=never`; no recursion |
| `local.stat` | Literal local paths with `-L`, `-f`, `-t`, or their long forms |
| `local.uname` | Standard system information flags, such as `-a` or `-sm` |
| `local.whoami` | No arguments |
| `local.id` | Current user only: no arguments, `-u`, `-g`, `-G`, `-un`, `-gn`, or `-Gn` |
| `local.basename` | One literal local path, optionally after `--` |
| `local.dirname` | One literal local path, optionally after `--` |

Matching checks the **entire command and tool input**. Simple quoted paths with
spaces are supported. Pipes, command chaining, newlines, redirection, expansion,
globs, escapes, wrappers, executable paths, unknown flags and URL filesystems
all fall through to normal review, even when suspicious syntax appears inside
quotes. Service, environment, PTY and background execution parameters also fall
through, as do unknown tool input fields. Only ordinary `cwd`, a positive
`timeout` up to 300 seconds, and `pty: false` / `async: false` are accepted in
addition to `command`. Commands are bounded to 4096 characters and 128 words.

Rules assume trusted standard utilities and OMP's execution environment. They
do not verify binaries, PATH, shell startup code or direnv configuration.
Commands such as `git status`, `git diff`, `find`, `sed` and `rg` remain on the
model path: their configuration or options can run external code or write files.
Shell file-content readers and network commands are also outside the library.

With auditing enabled, a match produces `outcome: "baseline_allow"` and the rule
ID in `detail`, using the existing input fingerprint without logging raw arguments.
The catalogue and argument grammars live together in
[`src/baseline-rules.ts`](src/baseline-rules.ts). Add both positive and bypass
regression cases in `test/baseline-rules.test.ts` when extending the library;
unrecognized syntax should always fall through to review.

## Configuration and review behavior

Approval dialogs offer **Allow once**, **Allow exact call for this session** and,
for eligible literal shell commands, **Save command rule…**. Saving a rule shows
the full token prefix and working directory before confirmation. Such a prefix
also matches additional trailing arguments; shorter prefixes can be configured
explicitly through `/permission scoped add`.

Session approvals bind the tool, full input, working directory, session, agent
and effective configuration. They are held only in memory, never created by a
model allow, and cleared when a changed configuration is observed. They do not
transfer to subagents or resumed processes. `/permission approvals list` shows
grant IDs; `approvals revoke <id>` or `approvals clear` removes them. Persistent
rules are removed with `/permission scoped remove <id>`. A missing UI blocks
requests that still need approval. Unsupported UI hosts retain one-call confirms.

Scoped rules are stored in `scopedRules` and managed with `/permission scoped
list`, `/permission scoped remove <id>`, or `/permission scoped add <JSON>`:

```json
{"id":"project-tests","kind":"command","cwd":"/work/project","prefix":["bun","test"],"decision":"allow"}
```

```json
{"id":"project-source","kind":"path","tool":"write","root":"/work/project/src","decision":"allow"}
```

Command rules match literal tokens in an exact working directory. Supported
`;`, `&&`, `||` and `|` combinations need an allow rule for every component.
Expansion, redirection, background execution, environment overrides and commands
that change shell state fall through to review. Broad interpreter allow prefixes
are rejected. A command allow rule trusts that command's implementation, scripts,
configuration and executable lookup; it does not restrict their filesystem effects.
Path rules cover the built-in `read` and ordinary `write` schemas. Opaque `edit`
patches and custom tools remain subject to their tool policy or model review.

Matching scoped denials take priority over all allows. Otherwise explicit tool
rules and non-review global modes take priority, followed by scoped rules (ask
before allow), baseline rules and the model. Unknown syntax cannot match a scoped
rule; scoped rules are not a sandbox or a universal deny filter for opaque tools.

`/permission explain bash {"command":"bun test"}` reports the local decision,
source, rule ID and reason without executing the command or calling the model.

`config.json` can be managed by Nix or another tool. `/permission` never writes
to it. Changes are stored with mode `0600` in a separate `user.json` beside it;
user settings override managed defaults. `/permission path` shows both paths,
and `/permission reset` removes only `user.json`.

With no file, `model` defaults to `current`, using the active OMP model and
its credentials. The reviewer receives the exact tool input and all genuine user
messages on the current branch, retaining early constraints and later revocations.
Up to six recent assistant/agent messages provide explicitly untrusted context;
they are omitted first when the byte budget is tight. User instructions and tool
input are never silently truncated: if they cannot fit, review uses the failure
policy. Subagent task messages are included separately
as untrusted context, not as evidence of user authorization. An oversized
request, invalid configuration, missing credentials, timeout, or malformed
reviewer output asks for manual approval in an interactive session and blocks
in headless mode.

Thinking stays enabled for reasoning-capable models, with `low` requested by
default. `/permission thinking low|medium|high` changes the requested effort;
actual support depends on the model/provider. Non-reasoning models omit the effort.

The default is **2 retries after the first attempt**, within a **20-second total
budget**. `/permission budget 20` controls the total; `/permission timeout 10`
sets an additional per-attempt cap. Authentication, provider work and retry delays
all consume the same total budget. The earlier `timeoutMs` JSON field remains a
per-attempt cap; existing files inherit `reviewTimeoutMs: 20000` unless explicitly
set. This intentionally shortens previous multi-minute fallback waits in 1.0.
The total budget supports up to 1800 seconds; a single attempt up to 300 seconds.

`/permission retries 0` disables retries; supported values are 0–5. Transient
connection/provider failures and invalid responses may retry with a 1-second delay.
Valid allow/deny/defer decisions are final. Missing credentials, invalid configuration
and permanent HTTP 4xx errors do not retry. Cancellation and exhausted total budgets
never start another attempt. Failure uses the configured ask/deny fallback.

`/permission cancel` stops active reviews for this session and blocks their tools.
Session shutdown also cancels running reviews. Late provider responses and late
authentication cannot approve or dispatch a request after cancellation or expiry.

`/permission show` displays the effective maximum wait and OMP handler budget.
The extension raises the runtime handler limit with 5 seconds of margin, never
lowering an existing larger limit or writing OMP's managed configuration. Manual
approval dialogs pause OMP's handler timer. Restart OMP after upgrading loaded code.

Requests labeled `defer`, and high-risk allows without enough user
authorization, ask the user in an interactive session and block in headless
mode. Critical-risk decisions always deny.

New genuine user messages invalidate session grants. A change to user instructions
or effective settings while review or an approval dialog is running blocks the
stale result and requires a fresh tool call. Parent instructions are not inferred
from delegated task text when OMP does not expose verified parent evidence.

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
