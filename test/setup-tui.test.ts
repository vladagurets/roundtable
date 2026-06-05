import test from "node:test";
import assert from "node:assert/strict";
import {
  computeListViewport,
  confirmExistingConfig,
  formatConfigSummary,
  modelOptionsFor,
  parseClaudeModelsFromHelp,
  parseCodexModelCatalog,
  parseCursorModelLine,
  parseModelListLine,
  resolveListViewport,
  runSetupTui
} from "../src/setup-tui.ts";
import { SetupTui } from "../src/setup/setup-tui.ts";
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
  assert.match(output.text, /\u001b\[H[\s\S]*\u001b\[J/);
  assert.doesNotMatch(output.text, /\u001b\[H\u001b\[J/);
});

test("confirmExistingConfig returns existing config when stdout is not a TTY", async () => {
  const output = new MemoryWritable();
  const choice = await confirmExistingConfig("/tmp/debate", sampleConfig, { output });
  assert.equal(choice.setupFromScratch, false);
  assert.deepEqual(choice.config, sampleConfig);
});

test("modelOptionsFor prefers discovered models and keeps curated fallbacks", () => {
  const options = modelOptionsFor("codex", () => ["gpt-5.6 - GPT-5.6", "gpt-5.5 - GPT-5.5"]);
  assert.deepEqual(
    options.map((option) => option.value),
    ["gpt-5.6", "gpt-5.5", "__custom__"]
  );
  assert.equal(options.find((option) => option.value === "gpt-5.6")?.label, "gpt-5.6 — GPT-5.6");
  assert.equal(options.find((option) => option.value === "gpt-5.5")?.label, "gpt-5.5 — GPT-5.5");
});

test("parseCodexModelCatalog returns visible model ids with display labels", () => {
  const lines = parseCodexModelCatalog(`WARNING: noisy stderr
{"models":[{"slug":"gpt-5.6","display_name":"GPT-5.6","visibility":"list"},{"slug":"internal-model","display_name":"Internal","visibility":"hidden"},{"slug":"o4-mini","display_name":"o4-mini","visibility":"list"}]}
WARNING: trailing stderr`);

  assert.deepEqual(lines, ["gpt-5.6 - GPT-5.6", "o4-mini"]);
});

test("modelOptionsFor keeps claude-opus-4-6 when Claude discovery omits it", () => {
  const options = modelOptionsFor("claude", () => ["sonnet", "opus", "claude-opus-4-8"]);

  assert.deepEqual(
    options.map((option) => option.value),
    ["sonnet", "opus", "claude-opus-4-8", "claude-opus-4-6", "__custom__"]
  );
});

test("parseClaudeModelsFromHelp extracts aliases and full model examples", () => {
  const lines = parseClaudeModelsFromHelp("Provide an alias (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-opus-4-8').");

  assert.deepEqual(lines, ["sonnet", "opus", "claude-opus-4-8"]);
});

test("modelOptionsFor supports cursor discovery and custom option", () => {
  const options = modelOptionsFor("cursor", () => ["composer-2.5 - Composer 2.5", "auto"]);
  assert.deepEqual(
    options.map((option) => option.value),
    ["composer-2.5", "auto", "__custom__"]
  );
  assert.equal(options.find((option) => option.value === "composer-2.5")?.label, "composer-2.5 — Composer 2.5");
});

test("parseModelListLine ignores non-model lines and parses id labels", () => {
  assert.deepEqual(parseModelListLine("gpt-5.4-medium - GPT-5.4 1M"), {
    value: "gpt-5.4-medium",
    label: "gpt-5.4-medium — GPT-5.4 1M"
  });
  assert.equal(parseModelListLine("Tip: use --model <id>"), null);
  assert.equal(parseModelListLine("Usage: agent --list-models"), null);
  assert.deepEqual(parseCursorModelLine("auto"), { value: "auto", label: "auto" });
});

test("resolveListViewport keeps selection visible while scrolling", () => {
  assert.deepEqual(resolveListViewport(0, 0, 50, 8), {
    scrollTop: 0,
    maxVisible: 8,
    visibleStart: 0,
    visibleEnd: 8,
    above: 0,
    below: 42
  });

  assert.deepEqual(resolveListViewport(20, 0, 50, 8), {
    scrollTop: 13,
    maxVisible: 8,
    visibleStart: 13,
    visibleEnd: 21,
    above: 13,
    below: 29
  });
});

test("computeListViewport limits visible rows to terminal height", () => {
  const viewport = computeListViewport(25, 0, 50, 24, 8);
  assert.ok(viewport.maxVisible <= 12);
  assert.equal(viewport.visibleStart, 16);
  assert.equal(viewport.visibleEnd, viewport.visibleStart + viewport.maxVisible);
});

test("SetupTui select scrolls long cursor model lists", async () => {
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();
  output.rows = 20;
  const ui = new SetupTui(input, output);

  const items = Array.from({ length: 40 }, (_, index) => ({
    label: `model-${index}`,
    value: `model-${index}`
  }));

  const choicePromise = ui.select("Model for cursor", "Pick a model", items);
  await new Promise((resolve) => setTimeout(resolve, 25));

  let text = stripAnsi(output.text);
  assert.match(text, /model-0/);
  assert.doesNotMatch(text, /model-39/);
  assert.match(text, /↓ \d+ more/);

  input.push("\u001b[B".repeat(39));
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.push("\n");

  const choice = await choicePromise;
  assert.equal(choice, "model-39");
  ui.close();

  text = stripAnsi(output.text);
  assert.match(text, /model-39/);
  assert.match(text, /↑ \d+ more/);
});

test("runSetupTui collects per-actor selections and returns config", async () => {
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();

  const configPromise = runSetupTui("/tmp/debate", {
    input,
    output,
    probe: (command) => command === "codex" || command === "claude",
    listModels: () => []
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

test("runSetupTui accepts a custom Claude model after selecting Custom", async () => {
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();

  const configPromise = runSetupTui("/tmp/debate", {
    input,
    output,
    probe: (command) => command === "codex" || command === "claude",
    listModels: (cli) => cli === "claude" ? ["sonnet", "opus", "claude-opus-4-8"] : []
  });

  await writeKeys(input, "1\n"); // actor count
  await writeKeys(input, "\u001b[B\n"); // choose claude
  await writeKeys(input, "\u001b[B\n"); // default claude-opus-4-6 -> Custom
  await writeKeys(input, "claude-custom\n");
  await writeKeys(input, "\n"); // role
  await writeKeys(input, "\n"); // leader
  await writeKeys(input, "\n"); // limit
  await writeKeys(input, "\n"); // human in loop
  await writeKeys(input, "\n"); // confirm

  const config = await configPromise;

  assert.equal(config.actors[0].cli, "claude");
  assert.equal(config.actors[0].model, "claude-custom");
  assert.equal(config.models.claude, "claude-custom");
  assert.match(stripAnsi(output.text), /Enter model id for claude/);
  assert.match(output.text, /\u001b\[\?25h[\s\S]*Enter model id for claude/);
});

async function writeKeys(input: MockTtyInput, keys: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
  input.push(keys);
}

function linesToText(lines: string[]): string {
  return lines.join("\n");
}
