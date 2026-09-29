# Changelog

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
