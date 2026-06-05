import test from "node:test";
import assert from "node:assert/strict";
import { confirmExistingConfig, formatConfigSummary, modelOptionsFor, runSetupTui } from "../src/setup-tui.ts";
import type { DebateConfig } from "../src/types.ts";
import { MemoryWritable, MockTtyInput, stripAnsi, TtyMemoryWritable } from "./helpers/mock-tty.ts";

const sampleConfig: DebateConfig = {
  debateMode: "single-cli",
  actors: [
    { cli: "gemini", model: "gemini-3-flash-preview", role: "peer" },
    { cli: "gemini", model: "gemini-3-flash-preview", role: "critic" }
  ],
  leader: "gemini",
  limit: 5,
  humanInTheLoop: false,
  models: {
    gemini: "gemini-3-flash-preview"
  }
};

test("formatConfigSummary lists actors and leader settings", () => {
  const text = stripAnsi(linesToText(formatConfigSummary(sampleConfig)));
  assert.match(text, /peer · gemini \(gemini-3-flash-preview\)/);
  assert.match(text, /Leader: gemini/);
  assert.match(text, /Limit: 5/);
});

test("confirmExistingConfig keeps existing config when selected", async () => {
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();

  const choicePromise = confirmExistingConfig("/tmp/debate", sampleConfig, { input, output });
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.push("\n");

  const choice = await choicePromise;
  assert.equal(choice.setupFromScratch, false);
  assert.deepEqual(choice.config, sampleConfig);
  const text = stripAnsi(output.text);
  assert.match(text, /Existing configuration/);
  assert.match(text, /Use existing configuration/);
  assert.match(text, /peer · gemini \(gemini-3-flash-preview\)/);
  assert.match(output.text, /\u001b\[38;2;\d+;\d+;\d+m╭/);
});

test("confirmExistingConfig returns existing config when stdout is not a TTY", async () => {
  const output = new MemoryWritable();
  const choice = await confirmExistingConfig("/tmp/debate", sampleConfig, { output });
  assert.equal(choice.setupFromScratch, false);
  assert.deepEqual(choice.config, sampleConfig);
});

test("modelOptionsFor includes custom option and cursor fallbacks", () => {
  const options = modelOptionsFor("cursor", () => ["composer-2.5", "auto"]);
  assert.deepEqual(
    options.map((option) => option.value),
    ["auto", "composer-2.5", "__custom__"]
  );
});

test("runSetupTui collects per-actor selections and returns config", async () => {
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();

  const configPromise = runSetupTui("/tmp/debate", {
    input,
    output,
    probe: (command) => command === "codex" || command === "claude",
    listCursorModels: () => []
  });

  for (let step = 0; step < 14; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    input.push("\n");
  }

  const config = await configPromise;

  assert.equal(config.debateMode, "single-cli");
  assert.equal(config.actors.length, 3);
  assert.equal(config.leader, "codex");
  assert.equal(config.limit, 5);
  assert.equal(config.humanInTheLoop, true);
  assert.equal(config.models.codex, "gpt-5.5");
  assert.equal(config.actors.every((actor) => actor.cli === "codex"), true);
  assert.match(output.text, /How many actors/);
  assert.match(output.text, /Save configuration/);
});

function linesToText(lines: string[]): string {
  return lines.join("\n");
}
