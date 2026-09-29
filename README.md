# omp-permission-auto-review

A permission manager for OMP with local policy checks, scoped rules, explicit
session approvals and an optional AI reviewer. One `tool_call` handler owns the
approval flow; policy evaluation, review, evidence and UI are separate modules.

## Status

Latest release: **1.0.2**, designed for Oh My Pi **18.3.2**. See the
[changelog](CHANGELOG.md). It covers OMP tool calls and
does not install an OS sandbox or enforce restrictions inside arbitrary shell
programs. See [migration notes](docs/migration-1.0.md). OMP's
native approval gate may still apply unless `tools.approvalMode` is `yolo`.

## Install

```sh
omp plugin link /path/to/omp-permission-auto-review
```

Disable `@gotgenes/pi-permission-system` and `@erichll/pi-auto-review` in OMP
before using this extension, so each call is reviewed once. For the extension
to own tool approval, set `tools.approvalMode: yolo` in OMP's `config.yml`.
By default, failed review blocks the call and returns a reason to the coding agent.
Explicit `failurePolicy: "ask"` opens manual approval in interactive sessions;
without a UI it blocks. A completed reviewer denial always blocks.

The optional configuration file is
`~/.omp/agent/extensions/omp-permission-auto-review/config.json`, or the same
path under the active OMP profile's agent directory:

```json
{
  "model": "current",
  "maxTokens": 4096,
  "timeoutMs": 20000,
  "reviewTimeoutMs": 20000,
  "maxRetries": 2,
  "reasoning": "low",
  "maxInputCharacters": 12000,
  "mode": "review",
  "profile": "custom",
  "reviewer": "model",
  "failurePolicy": "deny",
  "auditLog": true,
  "baselineRules": true,
  "toolRules": {},
  "scopedRules": []
}
```

## `/permission` settings

Run `/permission` for a compact menu with Nerd Font icons and current values.
Choose a profile, reviewer, save scope or a 10/20/60-second wait limit directly.
**Rules & approvals** groups tool exceptions, guided command/folder rules and
remembered approvals; **Activity & diagnostics** contains decision history and
configuration details. Model tuning and legacy modes live under **Advanced**.
Back or Escape returns to the main menu; Escape on the main menu closes it.
Changes keep you in the current group and show a short confirmation. Use a
Nerd Font in your terminal to display the icons; text labels remain readable
without it. Direct commands, including JSON rules, are still supported. User settings affect other sessions on their next call; session
overrides affect only that session and last only for this process.

| Profile command | Automatic behavior | Unmatched actions |
| --- | --- | --- |
| `/permission profile inspect` | Workspace reads and baseline queries | Ask you |
| `/permission profile workspace` | Also ordinary `write` calls inside the workspace | Model review |
| `/permission profile full-access` | Allow tools, subject to explicit rules | No model review |
| `/permission profile custom` | Legacy baseline reads/queries, no automatic writes | Model review |

Profiles preserve existing tool and scoped rules; inspect is not a hard read-only
sandbox. Workspace development does not auto-allow opaque `edit` patches or
arbitrary shell commands. `/permission reviewer user|model` selects who reviews
unmatched calls independently. Explicit tool rules set to `review` still request
the model. These commands apply the profile's mode/reviewer/baseline settings
together; manually changing advanced settings can customize that combination.

`/permission scope session` saves subsequent changes only to the current session.
`/permission scope user` restores persistent saving (the default).
`/permission sources` reports each setting's origin; `/permission session-reset`
clears session overrides and grants. User configuration still remains underneath.

Common and advanced settings can also be changed directly:

```text
/permission show
/permission path
/permission mode review|ask|deny|yolo
/permission fallback ask|deny
/permission model current|provider/model
/permission timeout 20
/permission budget 20
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

`review` checks local policy, then uses the selected reviewer for unmatched calls;
`ask` requires manual approval; `deny` blocks; `yolo` runs tools
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

Precedence is: a matching scoped denial, an exact tool rule, a non-review global
mode, other scoped rules (ask before allow), workspace-profile writes, baseline
rules, then the selected reviewer. A valid exact session grant can satisfy an
ask/review requirement, but cannot override a deny. An explicit
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
| `workspace.inspect` | Project-local `git diff` / `git status`, approved local queries and bounded output pipelines |

Baseline shell matching checks the **entire command and tool input**. Simple quoted paths with
spaces are supported. Fully recognized query chains and pipelines are supported;
newlines, redirection, expansion,
globs, escapes, wrappers, executable paths, unknown flags and URL filesystems
all fall through to normal review, even when suspicious syntax appears inside
quotes. Service, environment, PTY and background execution parameters also fall
through, as do unknown tool input fields. Only ordinary `cwd`, a positive
`timeout` up to 300 seconds, and `pty: false` / `async: false` are accepted in
addition to `command`. Commands are bounded to 4096 characters and 128 words.

Rules assume trusted standard utilities and OMP's execution environment. They
do not verify binaries, PATH, shell startup code or direnv configuration.
For Git inspection, the library checks effective Git configuration for external
helpers (diff, textconv, filters, fsmonitor and custom pagers), partial-clone
fetches and submodules. These cases, probe failures and unknown options still
use normal review. Checks share a 750 ms budget and are not cached across calls.
Git status may refresh index metadata; this rule does not authorize staging,
editing, deleting or publishing files.

For example, `cd /project/hw2 && git diff CMakeLists.txt | head -80` runs locally
without a model review when `/project/hw2` is inside the workspace and the checks
pass. The leading `cd` must use an existing absolute path and `&&`; `git -C hw2
diff` is also supported. `head`/`tail` with numeric limits and `sed -n '1,80p'`
may filter piped output, without reading named files or executing expressions.
Explicit tool policies and scoped ask/deny rules still take precedence, including
in the directory selected by `cd`. Prefix allows do not gain new shell syntax.
General `find`, `sed`, `rg`, shell file-content readers and network commands remain
on the review path because their options can have additional effects.

Model review also distinguishes inspection from a later edit/deletion: it should
allow ordinary low-risk investigation without demanding separate authorization
for every command or proof that each inspected file needs changing. Explicit
restrictions and uncertainty material to the action's risk still apply.

With auditing enabled, a match produces `outcome: "baseline_allow"` and the rule
ID in `detail`, using the existing input fingerprint without logging raw arguments.
The catalogue and argument grammars live together in
[`src/baseline-rules.ts`](src/baseline-rules.ts). Add both positive and bypass
regression cases in `test/baseline-rules.test.ts` when extending the library;
unrecognized syntax should always fall through to review.

## Configuration and review behavior

The TUI shows each running review's model, attempt, elapsed time and maximum
wait. **Ctrl+Alt+A** stops active reviews in this session and opens manual approval;
**Ctrl+Alt+X** cancels reviews and blocks their tools. `/permission manual` and
`/permission cancel` provide the same actions. Manual takeover is an explicit user
choice and can prompt even when automatic failure fallback is set to deny.

Approval dialogs show the reason, command/path and working directory; **Show full
input** exposes every argument. **Deny** rejects this call; **Cancel turn** also
interrupts the agent. Model denials remain final and do not expose an override.
The status distinguishes local/session allowance, reviewer denial, unavailable
reviewer, stale authorization and cancellation.

`/permission history` displays the last 50 decisions for this session, their
elapsed time and reasons, plus outcome counts. It stores input hashes rather than
raw arguments and remains in memory. `/permission doctor` checks model resolution,
UI availability and total wait, and explains potential overlapping approval gates.

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
before allow), profile/baseline allowances and the selected reviewer. Unknown syntax cannot match a scoped
rule; scoped rules are not a sandbox or a universal deny filter for opaque tools.

`/permission explain bash {"command":"bun test"}` reports the local decision,
source, rule ID and reason without executing the command or calling the model.

`config.json` can be managed by Nix or another tool. `/permission` never writes
to it. Persistent changes are stored with mode `0600` in a separate `user.json`
beside it. Precedence is defaults → managed → user → session; arrays and rule
objects are replaced by the higher layer rather than merged entry by entry.
`/permission path` shows both paths. `/permission reset` removes only `user.json`;
session overrides remain until `/permission session-reset` or session shutdown.

With no file, `model` defaults to `current`, using the active OMP model and
its credentials. The reviewer receives the exact tool input and all genuine user
messages on the current branch, retaining early constraints and later revocations.
Up to six recent assistant/agent messages provide explicitly untrusted context;
they are omitted first when the byte budget is tight. User instructions and tool
input are never silently truncated: if they cannot fit, review uses the failure
policy. Subagent task messages are included separately
as untrusted context, not as evidence of user authorization. An oversized
request, invalid configuration, missing credentials, timeout, or malformed
reviewer output blocks with an error by default. Explicit `failurePolicy: "ask"`
opens manual approval in interactive sessions; headless calls still block.

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
Guardian allow/deny decisions are final; model defer is not a valid output. Missing credentials, invalid configuration
and permanent HTTP 4xx errors do not retry. Cancellation and exhausted total budgets
never start another attempt. Failure uses the configured ask/deny fallback.

`/permission cancel` stops active reviews for this session and blocks their tools.
Session shutdown also cancels running reviews. Late provider responses and late
authentication cannot approve or dispatch a request after cancellation or expiry.

`/permission show` displays the effective maximum wait and OMP handler budget.
The extension raises the runtime handler limit with 5 seconds of margin, never
lowering an existing larger limit or writing OMP's managed configuration. Manual
approval dialogs pause OMP's handler timer. Restart OMP after upgrading loaded code.

Guardian returns allow or deny, and supports short low-risk allows. Critical-risk
decisions always deny. A denied action returns its reason to the coding agent.
The default failure policy is also `deny`, so unavailable review does not open a
selection dialog. Existing explicit `ask` overrides are preserved; use
`/permission fallback ask` or manual takeover if you want a dialog on failure.

New genuine user messages invalidate session grants. A change to user instructions
or effective settings while review or an approval dialog is running blocks the
stale result and requires a fresh tool call. Parent instructions are not inferred
from delegated task text when OMP does not expose verified parent evidence.

When `auditLog` is on, review records are written to
`~/.omp/agent/extensions/omp-permission-auto-review/logs/review.jsonl` (or
the active profile equivalent). They contain a SHA-256 fingerprint of the
tool input, the outcome, and a short rationale; they do not contain raw tool
arguments. The reviewer request itself does contain the arguments and recent
user text, so choose a model/provider accordingly. `maxInputCharacters` is retained
as a legacy field name but its limit is measured in UTF-8 bytes.

## Development

```sh
bun install
bun run check
bun test
```

## Origins and license

The 1.0 architecture is inspired by [OpenAI Codex](https://github.com/openai/codex/tree/c248f6d48b97eb4a2aa56147a0b11b7d763278b9):
execution-policy decisions, scoped approval caching, attributed authorization
evidence, shared review deadlines and approval presets. The TypeScript
implementation uses OMP's APIs; it does not embed Codex's Rust runtime or sandbox.

Most of the permission and reviewer policy design, the reviewer prompt, and
strict decision parsing are adapted from
[`@erichll/pi-auto-review`](https://github.com/erichll/pi-packages/tree/main/packages/pi-auto-review)
(version 0.21.0, MIT). The permission boundary and fail-closed design draw on
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
(version 34.0.1, MIT). The OMP event integration and package wiring are new.
This project is MIT licensed. Original upstream notices are reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).


## Codex Guardian review base

The reviewer uses the pinned Codex Guardian security policy, authorization scoring
and allow/deny output contract. Routine implementation steps inherit the user's
objective: fixing A can require reading or editing related B without separately
naming every file. The context includes original instructions, the relevant
assistant proposal, current tool intent, a proposed plan and recent observations.
If needed, the reviewer can gather bounded local evidence with `inspect_path`
within the same time budget. Explicit user limits and policy denials still apply.

See [the source mapping and host differences](docs/guardian-base.md) for the exact
upstream commit, licenses, inspection limits and manual-interaction behavior.
