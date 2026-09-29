# Migrating to 1.0.0

Restart OMP after updating the linked extension. Existing JSON files still load;
managed files are never modified by this release. Existing mode, model, tool rules,
retry count and per-attempt `timeoutMs` remain valid.

## Changed defaults and behavior

- `reviewTimeoutMs` defaults to **20000**, bounding all attempts, auth and retry
  delays. An old `timeoutMs: 120000` with two retries now waits at most 20 seconds
  unless you explicitly choose a larger `/permission budget`.
- Workspace reads join the enabled-by-default baseline library. An explicit
  `read=ask`, `read=deny`, or `read=review` continues to override it. Remove that
  tool rule to use baseline behavior.
- The default profile is `custom` and reviewer is `model`, preserving legacy
  review behavior for writes. Workspace auto-writes are opt-in through
  `/permission profile workspace`.
- Matching scoped denials beat allows. Unsupported command syntax cannot match
  a scoped rule and still needs normal policy/review handling.
- Genuine user messages on the current branch are retained together. If they
  and the exact tool input exceed the byte budget, the reviewer cannot make a
  decision; configured manual/deny fallback applies. It never silently drops an
  earlier restriction. Parent authority missing from a subagent is not invented.
- New user instructions or changed settings invalidate session grants and pending
  decisions. Reissue a tool call after such a change.
- Model denials are final. Timeout/unavailable, user denial, cancellation and
  stale authorization are distinct outcomes.

## Recommended setup

1. Run `/permission doctor` and ensure only one permission extension is installed.
   OMP's native gate may independently prompt; `tools.approvalMode: yolo` delegates
   that gate to this extension. The extension never changes it automatically.
2. Choose `/permission profile inspect` for local inspection plus manual approvals,
   or `/permission profile workspace` for local reads/ordinary writes plus model
   review. Existing explicit rules remain active; inspect them with `/permission
   show` and `/permission scoped list`.
3. Choose `/permission scope session` before experimenting with settings.
4. Use `/permission explain <tool> <JSON input>` to inspect policy without execution.
5. Use `/permission sources`, `/permission history` and `/permission doctor` for
   configuration, decision and runtime diagnostics respectively.

## Reversibility and boundaries

`/permission session-reset` clears in-memory settings and grants. `/permission
reset` removes persistent user overrides only. `/permission scoped remove <id>`
removes a saved rule from the current save scope. `/permission approvals clear`
revokes remembered approvals without changing settings.

Scoped command rules are token prefixes in an exact cwd, and allow trailing
arguments. Approving `bun test` therefore also permits `bun test ...`; approve
once/session instead if that is too broad. Supported file scopes apply to trusted
OMP `read`/`write` tools. Shell scripts, tool implementations, formatters and
external filesystem races are not confined by these checks. Native sandbox
integration and enforcement inside opaque patches remain separate future work.

The seven-commit plan and Codex source reference are in [1.0-plan.md](1.0-plan.md).
