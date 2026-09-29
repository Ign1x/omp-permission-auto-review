import type { Config, PermissionProfile } from "./config.ts";

export const PROFILES: Array<{ id: PermissionProfile; label: string; description: string; changes: Partial<Config> }> = [
  { id: "inspect", label: "Inspect project", description: "Allow local baseline queries and workspace reads; ask you about other actions.", changes: { profile: "inspect", mode: "review", reviewer: "user", baselineRules: true } },
  { id: "workspace", label: "Workspace development", description: "Also allow ordinary workspace writes; review other actions. Opaque edits and shell commands still need rules or review.", changes: { profile: "workspace", mode: "review", reviewer: "model", baselineRules: true } },
  { id: "full-access", label: "Full access", description: "Allow tools without model review, subject to explicit rules. This does not add a sandbox.", changes: { profile: "full-access", mode: "yolo", reviewer: "user" } },
  { id: "custom", label: "Custom / legacy review", description: "Baseline reads and queries, then model review; no automatic workspace writes.", changes: { profile: "custom", mode: "review", reviewer: "model", baselineRules: true } },
];
