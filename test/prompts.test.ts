import test from "node:test";
import assert from "node:assert/strict";
import { resolveActors } from "../src/config.ts";
import { buildActorPrompt, buildLeaderPrompt } from "../src/prompts.ts";

const actors = resolveActors({
  actors: [
    { cli: "claude", role: "proposer" },
    { cli: "gemini", role: "critic" }
  ],
  leader: "claude",
  limit: 3,
  humanInTheLoop: true,
  models: {
    claude: "sonnet",
    gemini: "flash"
  }
});

test("buildActorPrompt injects role behavior", () => {
  const prompt = buildActorPrompt({
    originalRequest: "Should we ship?",
    contexts: [],
    runningContext: "No context",
    recentTranscript: "None",
    currentQuestion: "What is the main risk?",
    roleName: actors[0].roleName,
    roleBehavior: actors[0].behavior
  });

  assert.match(prompt, /You are the Proposer/);
  assert.match(prompt, /Reasoning summary/);
  assert.match(prompt, /What is the main risk\?/);
});

test("buildLeaderPrompt lists participants in decision mode", () => {
  const prompt = buildLeaderPrompt({
    originalRequest: "Should we ship?",
    contexts: [],
    runningContext: "No context",
    recentTranscript: "None",
    limit: 3,
    questionsUsed: 0,
    humanInTheLoop: true,
    mode: "decision",
    participants: actors
  });

  assert.match(prompt, /Participants:/);
  assert.match(prompt, /proposer \(claude\)/);
  assert.match(prompt, /critic \(gemini\)/);
});
