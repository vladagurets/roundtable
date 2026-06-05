import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { LoadedContext } from "./types.ts";

function resolveContextPath(ref: string, cwd: string): string {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error("Invalid context reference. Path must not be empty.");
  }

  const expanded = trimmed.startsWith("~/")
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~")
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;

  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

export async function loadContextReferences(refs: string[], cwd = process.cwd()): Promise<LoadedContext[]> {
  const loaded: LoadedContext[] = [];

  for (const ref of refs) {
    const filePath = resolveContextPath(ref, cwd);

    try {
      loaded.push({
        ref,
        path: filePath,
        content: await readFile(filePath, "utf8")
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Missing context file @${ref}. Expected ${filePath}.`);
      }

      throw error;
    }
  }

  return loaded;
}
