import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// OMP 18.3 reads selectors from `path`, not separate offset/limit fields.
// Accept ordinary local paths and text selectors only. URLs, multi-path reads,
// globs, image questions and specialized archive/database selectors need review.
const LOCAL_PATH = /^[\p{L}\p{M}\p{N}_./()%+ =-]+$/u;
const LINE_RANGE = /^(?:[1-9]\d*(?:-[1-9]\d*|\+[1-9]\d*|-)?)(?:,[1-9]\d*(?:-[1-9]\d*|\+[1-9]\d*|-)?)*$|^-[1-9]\d*$/;

export function ordinaryPath(path: string): boolean {
  return LOCAL_PATH.test(path) && !path.startsWith("//") && path.trim() === path;
}

function textSelector(selector: string): boolean {
  const chunks = selector.split(":");
  if (chunks.length === 1) return chunks[0] === "raw" || LINE_RANGE.test(chunks[0]);
  return chunks.length === 2 && (
    (chunks[0] === "raw" && LINE_RANGE.test(chunks[1])) ||
    (chunks[1] === "raw" && LINE_RANGE.test(chunks[0]))
  );
}

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** A permission shortcut for trusted OMP local reads, not a filesystem sandbox. */
export function isWorkspaceRead(input: unknown, cwd: string): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const call = input as Record<string, unknown>;
  if (Object.keys(call).length !== 1 || typeof call.path !== "string" || call.path.length > 4096) return false;
  if (!isAbsolute(cwd) || !ordinaryPath(cwd)) return false;
  const [path, ...selectors] = call.path.split(":");
  if (!ordinaryPath(path) || (selectors.length > 0 && !textSelector(selectors.join(":")))) return false;
  try {
    const root = realpathSync(cwd);
    let target = resolve(cwd, path);
    if (!inside(cwd, target)) return false;
    if (selectors.length) {
      // OMP prefers an existing literal filename over selector interpretation.
      // Do not approve a different file if `file:1-10` exists (even as a dangling link).
      try {
        lstatSync(resolve(cwd, call.path));
        return false;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      }
    }
    target = realpathSync(target);
    if (!inside(root, target)) return false;
    const stat = statSync(target);
    return stat.isFile() || stat.isDirectory();
  } catch {
    // Missing/ambiguous paths may trigger OMP's suffix search or path aliases.
    // Leave those, unreadable paths, and special files on the reviewer path.
    return false;
  }
}
