import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DebateSession } from "../src/session.ts";

test("creates dated slugged report files and de-duplicates names", async () => {
  const root = await tempRoot();
  const now = new Date("2026-06-05T10:00:00.000Z");

  const first = await DebateSession.create(root, "My unusual product idea", [], { now });
  const second = await DebateSession.create(root, "My unusual product idea", [], { now });

  assert.match(first.reportPath, /2026-06-05-my-unusual-product-idea\.md$/);
  assert.match(first.logPath, /2026-06-05-my-unusual-product-idea\.log\.jsonl$/);
  assert.match(second.reportPath, /2026-06-05-my-unusual-product-idea-2\.md$/);
  assert.match(second.logPath, /2026-06-05-my-unusual-product-idea-2\.log\.jsonl$/);
});

test("writes detailed session log events separately from compact report", async () => {
  const root = await tempRoot();
  const session = await DebateSession.create(root, "Question", [], { now: new Date("2026-06-05T10:00:00.000Z") });

  await session.appendLog({ type: "raw_error", error: "Detailed stack trace" });

  const markdown = await readFile(session.reportPath, "utf8");
  const log = await readFile(session.logPath, "utf8");
  assert.doesNotMatch(markdown, /Detailed stack trace/);
  assert.match(log, /"type":"session_created"/);
  assert.match(log, /"type":"raw_error"/);
  assert.match(log, /Detailed stack trace/);
});

test("appends round records and replaces running context", async () => {
  const root = await tempRoot();
  const session = await DebateSession.create(root, "Question", [], { now: new Date("2026-06-05T10:00:00.000Z") });

  await session.appendLeaderQuestion(1, "What matters?");
  await session.appendRoundRecord(1, "What matters?", [
    {
      actor: {
        id: "peer-codex",
        cli: "codex",
        role: "peer",
        roleName: "Peer",
        model: "gpt-5.5",
        behavior: "peer behavior",
        label: "peer · codex"
      },
      ok: true,
      output: "The answer"
    }
  ], "Compact summary");
  await session.updateRunningContext("Compact summary");

  const markdown = await readFile(session.reportPath, "utf8");
  assert.match(markdown, /## Running Context\n\nCompact summary\n\n## Transcript/);
  assert.match(markdown, /### Round 1 Leader Question/);
  assert.match(markdown, /### Round 1 Compact Record/);
  assert.match(markdown, /peer · codex: answered/);
});

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "debate-session-"));
}
