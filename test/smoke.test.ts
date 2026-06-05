import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveActors } from "../src/config.ts";
import { ProcessAgentAdapter } from "../src/adapters.ts";
import { DebateEngine } from "../src/engine.ts";

test("end-to-end smoke test uses mock adapter commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "debate-smoke-"));
  const mockCommand = path.join(root, "mock-agent.mjs");
  await writeFile(mockCommand, [
    "let input = '';",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  if (process.argv.includes('--leader')) {",
    "    const mode = process.argv.at(-1);",
    "    if (mode === 'decision') console.log(JSON.stringify({ needsClarification: false, nextQuestion: 'What improves the idea?', shouldStop: false }));",
    "    else if (mode === 'summary') console.log(JSON.stringify({ needsClarification: false, roundSummary: 'The actors improved the idea.', shouldStop: false }));",
    "    else console.log(JSON.stringify({ needsClarification: false, shouldStop: true, finalSynthesis: 'Ship the improved idea.' }));",
    "  } else {",
    "    console.log('mock actor answer');",
    "  }",
    "});"
  ].join("\n"), "utf8");

  const leader = new ProcessAgentAdapter("codex", (prompt, expectedDecision) => ({
    command: process.execPath,
    args: [mockCommand, "--leader", expectedDecision ?? "decision"],
    stdin: prompt
  }));
  const actor = new ProcessAgentAdapter("claude", (prompt) => ({
    command: process.execPath,
    args: [mockCommand],
    stdin: prompt
  }));

  const actors = resolveActors({
    actors: [{ cli: "claude", role: "peer" }],
    leader: "codex",
    limit: 1,
    humanInTheLoop: false,
    models: { claude: "sonnet", codex: "gpt-5.5" }
  });

  const result = await new DebateEngine({
    rootDir: root,
    request: "Debate this",
    actors,
    limit: 1,
    leader: "codex",
    humanInTheLoop: false,
    contexts: [],
    leaderAdapter: leader,
    createActorAdapter: () => actor,
    now: new Date("2026-06-05T10:00:00.000Z")
  }).run();

  assert.equal(result.finalSynthesis, "Ship the improved idea.");
  assert.equal(result.rounds, 1);
});
