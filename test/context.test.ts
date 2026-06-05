import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadContextReferences } from "../src/context.ts";

test("loads context references from relative paths", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "brief.md"), "The brief", "utf8");

  const contexts = await loadContextReferences(["brief.md"], root);

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].ref, "brief.md");
  assert.equal(contexts[0].content, "The brief");
});

test("loads nested and parent-relative paths", async () => {
  const root = await tempRoot();
  const nested = path.join(root, "docs");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "plan.md"), "Plan", "utf8");

  const contexts = await loadContextReferences(["./docs/plan.md"], root);

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].content, "Plan");
});

test("rejects missing files", async () => {
  const root = await tempRoot();

  await assert.rejects(() => loadContextReferences(["missing.md"], root), /Missing context file/);
});

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "debate-context-"));
}
