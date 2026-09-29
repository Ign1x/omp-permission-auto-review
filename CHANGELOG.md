# Changelog

## 1.0.2 — 2026-09-29

- Base model review on Codex Guardian's pinned security policy, authorization scoring and allow/deny contract, with Apache-2.0 notices included.
- Preserve task plans, pending tool intent and recent observations; allow proportionate necessary implementation steps without exact-file authorization.
- Give the reviewer bounded, read-only filesystem probes within the existing deadline and cancellation controls.
- Default failed review to a reason returned to the agent rather than a manual dialog; preserve explicit `failurePolicy: ask` and manual takeover.
- Allow verified project-local Git diff/status and bounded query pipelines, including a leading project `cd`, without model review.
- Retain helper/configuration checks and explicit restrictions; bound local probes to 750 ms.
- Clarify that low-risk inspection is a normal task prerequisite, even when later edits or deletions are not yet determined.

## 1.0.1 — 2026-09-29

- Simplify settings into eight main entries with Nerd Font icons, current values and persistent submenus.
- Add quick review budgets, tool selection and command/folder rule wizards with readable scope previews.
- Keep interactive save feedback short; retain detailed output for direct commands.

## 1.0.0 — 2026-09-29

1. Separate local permission evaluation from model review; allow supported workspace reads locally.
2. Add cwd-scoped command prefixes, read/write path rules, conservative compound-command parsing and policy explanation.
3. Add explicit once/session/persistent approvals, rule previews, grant listing and revocation.
4. Preserve attributed user instructions and reject stale model/manual approvals.
5. Bound the full review with a configurable total deadline and cancellation.
6. Add review progress, manual takeover, input inspection, distinct outcome feedback and session diagnostics.
7. Add profiles, independent reviewer selection, session configuration, provenance and an advanced settings menu.

Existing configurations inherit a 20-second total review limit; see the
[migration guide](docs/migration-1.0.md). No OS sandbox is installed.
