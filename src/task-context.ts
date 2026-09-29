import type { ExtensionContext, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
export interface TaskContextItem {
  order: number;
  source: "assistant" | "tool";
  kind: "current-intent" | "plan" | "tool-call" | "tool-result";
  text: string;
  truncated: boolean;
}

function excerpt(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  // Retain whole Unicode code points. This is background, never current input or user instructions.
  let used = 0, result = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    result += char; used += size;
  }
  return { text: result, truncated: true };
}

/** Host-recorded proposals/results explain task relationships; none grant permission. */
export function taskContext(branch: Branch, event: ToolCallEvent): TaskContextItem[] {
  const current: TaskContextItem[] = [], plans: TaskContextItem[] = [], recent: TaskContextItem[] = [];
  for (const [order, entry] of branch.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        if (part.id === event.toolCallId && part.name === event.toolName) {
          if (part.intent) current.push({ order, source: "assistant", kind: "current-intent", ...excerpt(part.intent, 1800) });
          continue; // Current input already appears verbatim in the evidence envelope.
        }
        const item: TaskContextItem = {
          order, source: "assistant", kind: part.name === "todo" ? "plan" : "tool-call",
          ...excerpt(JSON.stringify({ tool: part.name, input: part.arguments, ...(part.intent ? { intent: part.intent } : {}) }), part.name === "todo" ? 2400 : 900),
        };
        if (item.kind === "plan") plans.push(item); else recent.push(item);
      }
    } else if (message.role === "toolResult") {
      if (message.toolCallId === event.toolCallId) continue;
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      recent.push({ order, source: "tool", kind: "tool-result", ...excerpt(JSON.stringify({ tool: message.toolName, isError: message.isError, output: content }), 1400) });
    }
  }
  // Priority order for the byte-budget allocator, not chronology. The rendered
  // evidence is sorted by original branch order after entries have been selected.
  return [...current.slice(-1), ...plans.slice(-1), ...recent.slice(-6).reverse()];
}
