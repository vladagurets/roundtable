import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODELS } from "../src/types.ts";
import { parseActorsFlag, parseArgs, parseSingleCliFlag, printHelp, wantsHelp } from "../src/parser.ts";

test("wantsHelp detects help flags and empty argv", () => {
  assert.equal(wantsHelp([]), true);
  assert.equal(wantsHelp(["--help"]), true);
  assert.equal(wantsHelp(["-h"]), true);
  assert.equal(wantsHelp(["Review this plan"]), false);
});

test("printHelp includes key flags and config path", () => {
  let output = "";
  printHelp({
    write(chunk: string) {
      output += chunk;
    }
  } as NodeJS.WritableStream);

  assert.match(output, /--single-cli/);
  assert.match(output, /config\/debate\.json/);
  assert.match(output, /config\/debate\.example\.json/);
});

test("missing request points to help", () => {
  assert.throws(() => parseArgs([]), /roundtable --help/);
});

test("parses request and default options", () => {
  const options = parseArgs(["Improve this product idea"]);

  assert.equal(options.request, "Improve this product idea");
  assert.equal(options.actors.length, 4);
  assert.equal(options.limit, 5);
  assert.equal(options.leader, "codex");
  assert.equal(options.humanInTheLoop, true);
  assert.deepEqual(options.models, DEFAULT_MODELS);
});

test("parses long, short, equals, and separated flags", () => {
  const options = parseArgs([
    "Review @brief.md",
    "-clis=gemini,codex,codex",
    "-limit",
    "3",
    "--leader=gemini",
    "--human-in-the-loop=false",
    "--claude-model",
    "sonnet",
    "--codex-model=gpt-5.5-codex",
    "--gemini-model",
    "gemini-3-pro-preview",
    "--cursor-model",
    "composer-2.5"
  ]);

  assert.equal(options.actors.length, 2);
  assert.equal(options.actors.find((actor) => actor.cli === "gemini")?.role, "peer");
  assert.equal(options.limit, 3);
  assert.equal(options.leader, "gemini");
  assert.equal(options.humanInTheLoop, false);
  assert.deepEqual(options.models, {
    claude: "sonnet",
    codex: "gpt-5.5-codex",
    gemini: "gemini-3-pro-preview",
    cursor: "composer-2.5"
  });
  assert.deepEqual(options.contextRefs, ["brief.md"]);
});

test("extracts local file path mentions as context references", () => {
  const options = parseArgs(["Review ./knowledge-hub.md and /tmp/brief.md"]);

  assert.deepEqual(options.contextRefs, ["./knowledge-hub.md", "/tmp/brief.md"]);
});

test("uses config defaults when flags are omitted", () => {
  const options = parseArgs(["Review this plan"], {
    debateMode: "multi-cli",
    actors: [
      { cli: "claude", role: "proposer" },
      { cli: "gemini", role: "critic" }
    ],
    leader: "claude",
    limit: 7,
    humanInTheLoop: false,
    models: {
      claude: "sonnet",
      gemini: "gemini-2.5-flash"
    }
  });

  assert.equal(options.actors.length, 2);
  assert.equal(options.actors[0].role, "proposer");
  assert.equal(options.leader, "claude");
  assert.equal(options.limit, 7);
  assert.equal(options.humanInTheLoop, false);
  assert.equal(options.models.claude, "sonnet");
  assert.equal(options.models.gemini, "gemini-2.5-flash");
  assert.equal(options.models.codex, DEFAULT_MODELS.codex);
});

test("cli flags override config defaults", () => {
  const options = parseArgs(["Review this plan", "--clis=codex", "--limit=2", "--leader=codex", "--human-in-the-loop=true", "--codex-model=gpt-5.5-codex"], {
    debateMode: "multi-cli",
    actors: [
      { cli: "claude", role: "proposer" },
      { cli: "gemini", role: "critic" }
    ],
    leader: "gemini",
    limit: 7,
    humanInTheLoop: false,
    models: {
      claude: "sonnet",
      gemini: "gemini-2.5-flash"
    }
  });

  assert.equal(options.actors.length, 1);
  assert.equal(options.actors[0].cli, "codex");
  assert.equal(options.leader, "codex");
  assert.equal(options.limit, 2);
  assert.equal(options.humanInTheLoop, true);
  assert.equal(options.models.codex, "gpt-5.5-codex");
});

test("parses --actors and --single-cli flags", () => {
  const actors = parseActorsFlag("claude:proposer,gemini:critic");
  assert.deepEqual(actors, [
    { cli: "claude", role: "proposer" },
    { cli: "gemini", role: "critic" }
  ]);

  const single = parseSingleCliFlag("claude:proposer,critic,verifier");
  assert.equal(single.cli, "claude");
  assert.deepEqual(single.actors, [
    { cli: "claude", role: "proposer" },
    { cli: "claude", role: "critic" },
    { cli: "claude", role: "verifier" }
  ]);

  const options = parseArgs(["Review", "--single-cli=claude:proposer,critic"]);
  assert.equal(options.leader, "claude");
  assert.equal(options.actors.length, 2);
  assert.equal(options.actors[0].role, "proposer");

  const singleRole = parseSingleCliFlag("claude:proposer");
  assert.equal(singleRole.actors.length, 1);
  assert.equal(singleRole.actors[0].role, "proposer");
});

test("rejects invalid values", () => {
  assert.throws(() => parseArgs(["x", "--clis=codex,bard"]), /Invalid CLI/);
  assert.throws(() => parseArgs(["x", "--leader=bard"]), /Invalid leader/);
  assert.throws(() => parseArgs(["x", "--limit=0"]), /at least 1/);
  assert.throws(() => parseArgs(["x", "--human-in-the-loop=yes"]), /true or false/);
  assert.throws(() => parseArgs(["x", "--claude-model="]), /must not be empty/);
  assert.throws(() => parseArgs(["x", "--unknown=true"]), /Unknown flag/);
  assert.throws(() => parseArgs(["x", "--codex-model"]), /must include a value/);
  assert.throws(() => parseArgs(["x", "--cursor-model="]), /must not be empty/);
  assert.throws(() => parseArgs(["x", "--actors=claude", "--single-cli=claude:a,b"]), /either --actors or --single-cli/);
});
