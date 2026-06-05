import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { resolveActors } from "../src/config.ts";
import { DebateEngine, parseLeaderDecision, type DebateEngineOptions } from "../src/engine.ts";
import type { CliName, ResolvedActor } from "../src/types.ts";
import { DEFAULT_MODELS } from "../src/types.ts";
import { MockAdapter } from "./helpers/mock-adapter.ts";

// Scenarios: leader JSON parsing, compaction, clarification, failures, early finish guard, single-cli multi-role.

test("parses leader JSON surrounded by incidental text", () => {
  const decision = parseLeaderDecision('Thinking...\n{"needsClarification":false,"nextQuestion":"Q","shouldStop":false}\nDone');

  assert.equal(decision.needsClarification, false);
  assert.equal(decision.nextQuestion, "Q");
  assert.equal(decision.shouldStop, false);
});

test("parses the last decision object when output contains multiple JSON objects", () => {
  const decision = parseLeaderDecision([
    '{"type":"event","message":"not the decision"}',
    '{"needsClarification":false,"nextQuestion":"Q2","shouldStop":false}'
  ].join("\n"));

  assert.equal(decision.nextQuestion, "Q2");
});

test("ignores JSON objects embedded in surrounding prompt echoes", () => {
  const decision = parseLeaderDecision([
    "Return only JSON with this shape:",
    '{"example":true}',
    "Actual decision:",
    '{"needsClarification":false,"shouldStop":true,"finalSynthesis":"Done","modelObservations":"Codex was strongest; Gemini missed context."}',
    "tokens used: 123"
  ].join("\n"));

  assert.equal(decision.shouldStop, true);
  assert.equal(decision.finalSynthesis, "Done");
  assert.equal(decision.modelObservations, "Codex was strongest; Gemini missed context.");
});

test("runs leader-as-actor rounds, compacts memory, and produces final synthesis", async () => {
  const root = await tempRoot();
  const codex = new MockAdapter("codex", [
    { needsClarification: false, nextQuestion: "What is strongest?", shouldStop: false },
    { needsClarification: false, roundSummary: "Running compact summary", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Final answer", modelObservations: "Codex was strongest on implementation detail; Gemini was weaker because it stayed generic." }
  ], "Codex actor answer");
  const claude = new MockAdapter("claude", [], "Claude actor answer");
  const gemini = new MockAdapter("gemini", [], "Gemini actor answer");

  const result = await new DebateEngine(buildEngineOptions({
    rootDir: root,
    request: "Debate a proposal",
    actorClis: ["codex", "claude", "gemini"],
    leader: "codex",
    limit: 1,
    adapters: { codex, claude, gemini, cursor: new MockAdapter("cursor", [], "") }
  })).run();

  const markdown = await readFile(result.reportPath, "utf8");
  assert.equal(result.finalSynthesis, "Final answer");
  assert.equal(result.modelObservations, "Codex was strongest on implementation detail; Gemini was weaker because it stayed generic.");
  assert.equal(codex.actorCalls, 1);
  assert.equal(claude.actorCalls, 1);
  assert.equal(gemini.actorCalls, 1);
  assert.match(markdown, /Running compact summary/);
  assert.match(markdown, /Final answer/);
  assert.match(markdown, /## Leader Model Observations/);
  assert.match(markdown, /Codex was strongest on implementation detail/);
});

test("uses leader compacted context instead of replaying old raw actor output", async () => {
  const root = await tempRoot();
  const hugeActorOutput = `VERY_LARGE_ACTOR_TEXT ${"x".repeat(20_000)}`;
  const codex = new MockAdapter("codex", [
    { needsClarification: false, nextQuestion: "Question one", shouldStop: false },
    { needsClarification: false, roundSummary: "Compact context after round one", shouldStop: false },
    { needsClarification: false, nextQuestion: "Question two", shouldStop: false },
    { needsClarification: false, roundSummary: "Compact context after round two", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Final answer" }
  ], hugeActorOutput);

  const result = await new DebateEngine(buildEngineOptions({
    rootDir: root,
    request: "Debate a proposal",
    actorClis: ["codex"],
    leader: "codex",
    limit: 2,
    adapters: {
      codex,
      claude: new MockAdapter("claude", [], ""),
      gemini: new MockAdapter("gemini", [], ""),
      cursor: new MockAdapter("cursor", [], "")
    }
  })).run();

  const markdown = await readFile(result.reportPath, "utf8");
  const log = await readFile(result.logPath, "utf8");
  assert.equal(result.finalSynthesis, "Final answer");
  assert.equal(codex.actorPrompts.length, 2);
  assert.equal(codex.leaderPrompts.length, 5);
  assert.doesNotMatch(markdown, /VERY_LARGE_ACTOR_TEXT/);
  assert.match(log, /VERY_LARGE_ACTOR_TEXT/);
  assert.match(log, /"type":"actor_result"/);
  assert.match(log, /"type":"leader_prompt"/);
  assert.match(markdown, /peer · codex: answered \(20022 chars before compaction\)/);
  assert.match(codex.leaderPrompts[1], /VERY_LARGE_ACTOR_TEXT/);
  assert.doesNotMatch(codex.actorPrompts[1], /VERY_LARGE_ACTOR_TEXT/);
  assert.doesNotMatch(codex.leaderPrompts[2], /VERY_LARGE_ACTOR_TEXT/);
  assert.match(codex.actorPrompts[1], /Compact context after round one/);
});

test("emits progress status lines while orchestration runs", async () => {
  const root = await tempRoot();
  const output = new MemoryWritable();
  const codex = new MockAdapter("codex", [
    { needsClarification: false, nextQuestion: "What is strongest?", shouldStop: false },
    { needsClarification: false, roundSummary: "Running compact summary", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Final answer" }
  ], "Codex actor answer");

  await new DebateEngine({
    ...buildEngineOptions({
      rootDir: root,
      request: "Debate a proposal",
      actorClis: ["codex"],
      leader: "codex",
      limit: 1,
      adapters: {
        codex,
        claude: new MockAdapter("claude", [], ""),
        gemini: new MockAdapter("gemini", [], ""),
        cursor: new MockAdapter("cursor", [], "")
      }
    }),
    output
  }).run();

  assert.match(output.text, /\[roundtable\] Report:/);
  assert.match(output.text, /\[roundtable\] Logs:/);
  assert.match(output.text, /\[roundtable\] Leader: codex \(gpt-5\.5\)/);
  assert.match(output.text, /\[roundtable\] Participants: peer · codex \(gpt-5\.5\)/);
  assert.match(output.text, /\[roundtable\] Leader: codex decision is thinking\./);
  assert.match(output.text, /\[roundtable\] Leader decision chose the next question\./);
  assert.match(output.text, /\[roundtable\] Round 1\/1: leader asked a question\./);
  assert.match(output.text, /\[roundtable\] Participants are answering\./);
  assert.match(output.text, /\[roundtable\] Participant: peer · codex is answering\./);
  assert.match(output.text, /\[roundtable\] Running context compacted\./);
  assert.match(output.text, /\[roundtable\] Final synthesis saved\./);
  assert.doesNotMatch(output.text, /What is strongest\?/);
  assert.doesNotMatch(output.text, /Codex actor answer/);
  assert.doesNotMatch(output.text, /Final answer/);
});

test("forces a first peer round when leader tries to finish immediately", async () => {
  const root = await tempRoot();
  const codex = new MockAdapter("codex", [
    { needsClarification: false, shouldStop: true, finalSynthesis: "Early solo answer" },
    { needsClarification: false, roundSummary: "Peers challenged the solo answer", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Final after peers" }
  ], "Codex peer critique");
  const claude = new MockAdapter("claude", [], "Claude peer critique");
  const gemini = new MockAdapter("gemini", [], "Gemini peer critique");

  const result = await new DebateEngine(buildEngineOptions({
    rootDir: root,
    request: "Debate a proposal",
    actorClis: ["codex", "claude", "gemini"],
    leader: "codex",
    limit: 1,
    adapters: { codex, claude, gemini, cursor: new MockAdapter("cursor", [], "") }
  })).run();

  const markdown = await readFile(result.reportPath, "utf8");
  assert.equal(result.rounds, 1);
  assert.equal(result.finalSynthesis, "Final after peers");
  assert.equal(codex.actorCalls, 1);
  assert.equal(claude.actorCalls, 1);
  assert.equal(gemini.actorCalls, 1);
  assert.match(markdown, /Early synthesis:/);
  assert.match(markdown, /peer · claude: answered \(20 chars before compaction\)/);
  assert.match(markdown, /peer · gemini: answered \(20 chars before compaction\)/);
  assert.match(markdown, /Peers challenged the solo answer/);
});

test("handles one actor failure and continues with remaining actors", async () => {
  const root = await tempRoot();
  const codex = new MockAdapter("codex", [
    { needsClarification: false, nextQuestion: "Question", shouldStop: false },
    { needsClarification: false, roundSummary: "Summary", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Final" }
  ], "Codex answer");
  const claude = new MockAdapter("claude", [], "Claude answer");
  const gemini = new MockAdapter("gemini", [], "Gemini failed", 1);

  const result = await new DebateEngine(buildEngineOptions({
    rootDir: root,
    request: "Debate a proposal",
    actorClis: ["claude", "gemini"],
    leader: "codex",
    limit: 1,
    adapters: { codex, claude, gemini, cursor: new MockAdapter("cursor", [], "") }
  })).run();

  const markdown = await readFile(result.reportPath, "utf8");
  assert.equal(result.finalSynthesis, "Final");
  assert.match(markdown, /peer · claude: answered \(13 chars before compaction\)/);
  assert.match(markdown, /peer · gemini: failed - Gemini failed/);
});

test("asks one clarification when human-in-the-loop is enabled", async () => {
  const root = await tempRoot();
  const codex = new MockAdapter("codex", [
    { needsClarification: true, clarificationQuestion: "Which audience?", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Audience-specific early final" },
    { needsClarification: false, roundSummary: "Audience-specific peer summary", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Audience-specific final" }
  ], "Codex audience critique");
  let asked = "";

  const result = await new DebateEngine({
    ...buildEngineOptions({
      rootDir: root,
      request: "Debate a launch",
      actorClis: ["codex"],
      leader: "codex",
      limit: 2,
      humanInTheLoop: true,
      adapters: {
        codex,
        claude: new MockAdapter("claude", [], ""),
        gemini: new MockAdapter("gemini", [], ""),
        cursor: new MockAdapter("cursor", [], "")
      }
    }),
    askHuman: async (question) => {
      asked = question;
      return "Developers";
    }
  }).run();

  const markdown = await readFile(result.reportPath, "utf8");
  assert.equal(asked, "Which audience?");
  assert.equal(result.finalSynthesis, "Audience-specific final");
  assert.equal(result.rounds, 1);
  assert.equal(codex.actorCalls, 1);
  assert.match(markdown, /Developers/);
  assert.match(markdown, /peer · codex: answered \(23 chars before compaction\)/);
  assert.match(markdown, /Audience-specific peer summary/);
});

test("records final failure synthesis when no actors succeed", async () => {
  const root = await tempRoot();
  const codex = new MockAdapter("codex", [
    { needsClarification: false, nextQuestion: "Question", shouldStop: false }
  ], "Codex failed", 1);

  const result = await new DebateEngine(buildEngineOptions({
    rootDir: root,
    request: "Debate a proposal",
    actorClis: ["codex"],
    leader: "codex",
    limit: 2,
    adapters: {
      codex,
      claude: new MockAdapter("claude", [], ""),
      gemini: new MockAdapter("gemini", [], ""),
      cursor: new MockAdapter("cursor", [], "")
    }
  })).run();

  assert.match(result.finalSynthesis, /every actor failed/);
});

test("single-cli multi-role round runs parallel actor sessions with role labels", async () => {
  const root = await tempRoot();
  const claude = new MockAdapter("claude", [
    { needsClarification: false, nextQuestion: "What improves the idea?", shouldStop: false },
    { needsClarification: false, roundSummary: "Roles disagreed productively", shouldStop: false },
    { needsClarification: false, shouldStop: true, finalSynthesis: "Ship with safeguards" }
  ], "Role-specific answer");

  const actors = resolveActors({
    debateMode: "single-cli",
    actors: [
      { cli: "claude", role: "proposer" },
      { cli: "claude", role: "critic" },
      { cli: "claude", role: "verifier" }
    ],
    leader: "claude",
    limit: 1,
    humanInTheLoop: false,
    models: { claude: "sonnet" }
  });

  const result = await new DebateEngine({
    rootDir: root,
    request: "Debate this feature",
    actors,
    limit: 1,
    leader: "claude",
    humanInTheLoop: false,
    contexts: [],
    leaderAdapter: claude,
    createActorAdapter: () => claude,
    now: new Date("2026-06-05T10:00:00.000Z")
  }).run();

  const markdown = await readFile(result.reportPath, "utf8");
  assert.equal(result.finalSynthesis, "Ship with safeguards");
  assert.equal(claude.actorCalls, 3);
  const combinedPrompts = claude.actorPrompts.join("\n");
  assert.match(combinedPrompts, /You are the Proposer/);
  assert.match(combinedPrompts, /You are the Critic/);
  assert.match(combinedPrompts, /You are the Verifier/);
  assert.match(markdown, /proposer · claude: answered/);
  assert.match(markdown, /critic · claude: answered/);
  assert.match(markdown, /verifier · claude: answered/);
});

interface BuildEngineOptionsInput {
  rootDir: string;
  request: string;
  actorClis: CliName[];
  leader: CliName;
  limit: number;
  humanInTheLoop?: boolean;
  adapters: Record<CliName, MockAdapter>;
}

function buildEngineOptions(input: BuildEngineOptionsInput): DebateEngineOptions {
  const actors = resolveActors({
    actors: input.actorClis.map((cli) => ({ cli, role: "peer" })),
    leader: input.leader,
    limit: input.limit,
    humanInTheLoop: input.humanInTheLoop ?? false,
    models: Object.fromEntries(input.actorClis.map((cli) => [cli, DEFAULT_MODELS[cli]]))
  });

  return {
    rootDir: input.rootDir,
    request: input.request,
    actors,
    limit: input.limit,
    leader: input.leader,
    humanInTheLoop: input.humanInTheLoop ?? false,
    models: DEFAULT_MODELS,
    contexts: [],
    leaderAdapter: input.adapters[input.leader],
    createActorAdapter: (actor: ResolvedActor) => input.adapters[actor.cli],
    now: new Date("2026-06-05T10:00:00.000Z")
  };
}

class MemoryWritable extends Writable {
  text = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    callback();
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "debate-engine-"));
}
