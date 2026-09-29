import { constants } from "node:fs";
import { open, realpath, stat, opendir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Tool } from "@oh-my-pi/pi-ai";
import { ordinaryPath } from "./workspace-read.ts";

export const INSPECT_TOOL: Tool = {
  name: "inspect_path",
  description: "Gather missing local evidence before a permission decision. Stat, list or read a regular workspace file; no commands, writes or network. Only use if the result could change the decision.",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      path: { type: "string", description: "Workspace-relative or absolute local path." },
      operation: { type: "string", enum: ["stat", "list", "read"] },
      offset: { type: "integer", minimum: 0, maximum: 16777216, description: "Optional byte offset for reading." },
    }, required: ["path", "operation"],
  } as Tool["parameters"],
};

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function protectedContent(path: string): boolean {
  return path.split(sep).some((part) => [".git", ".ssh", ".aws", ".gnupg"].includes(part)) ||
    /^(?:\.env(?:\..*)?|(?:auth|credentials|secrets?|tokens?)(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|p12)$/i.test(basename(path));
}

/** Direct filesystem probes, deliberately separate from OMP's tool dispatch. */
export async function inspectPath(input: unknown, cwd: string, signal: AbortSignal, byteLimit = 6000): Promise<string> {
  signal.throwIfAborted();
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid inspection arguments");
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some((key) => !["path", "operation", "offset"].includes(key)) || typeof args.path !== "string" ||
        !ordinaryPath(args.path) || !["stat", "list", "read"].includes(args.operation as string) ||
        (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 16777216))) throw new Error("Invalid inspection arguments");
    const root = await realpath(cwd);
    const lexical = resolve(cwd, args.path);
    if (!inside(resolve(cwd), lexical)) throw new Error("Inspection is limited to the workspace");
    let path: string;
    try { path = await realpath(lexical); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return JSON.stringify({ path: args.path, exists: false });
      throw error;
    }
    if (!inside(root, path)) throw new Error("Inspection is limited to the workspace");
    signal.throwIfAborted();
    const metadata = await stat(path);
    const info = { path: args.path, exists: true, kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "special", size: metadata.size };
    if (args.operation === "stat") return JSON.stringify(info);
    if (protectedContent(lexical) || protectedContent(path)) throw new Error("Credential and internal metadata content is not available to the reviewer");
    if (args.operation === "list") {
      if (!metadata.isDirectory()) throw new Error("Not a directory");
      const entries: string[] = [];
      let truncated = false;
      for await (const entry of await opendir(path)) {
        signal.throwIfAborted();
        if (entries.length >= 80 || Buffer.byteLength(JSON.stringify(entries)) + Buffer.byteLength(entry.name) > byteLimit - 600) { truncated = true; break; }
        entries.push(entry.name);
      }
      return JSON.stringify({ ...info, entries, truncated });
    }
    if (!metadata.isFile()) throw new Error("Only regular text files may be read");
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      signal.throwIfAborted();
      const opened = await fd.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || !inside(root, await realpath(path))) throw new Error("Inspection target changed");
      if (process.platform === "linux" && !inside(root, await realpath(`/proc/self/fd/${fd.fd}`))) throw new Error("Inspection target left the workspace");
      const buffer = Buffer.alloc(Math.min(8192, Math.max(0, Math.floor((byteLimit - 600) / 6))));
      const offset = Number(args.offset ?? 0);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
      signal.throwIfAborted();
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error("Binary content is not available to the reviewer");
      return JSON.stringify({ ...info, offset, content: bytes.toString("utf8"), truncated: offset + bytesRead < metadata.size });
    } finally { await fd.close(); }
  } catch (error) {
    signal.throwIfAborted();
    return JSON.stringify({ error: error instanceof Error ? error.message : "Inspection unavailable" });
  }
}
