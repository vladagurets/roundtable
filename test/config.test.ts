import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  configFilePath,
  loadConfig,
  migrateLegacyConfig,
  resolveActors,
  saveConfig,
  validateConfig,
  validateResolvedOptions
} from "../src/config.ts";
import type { DebateConfig } from "../src/types.ts";

const legacyConfig = {
  clis: ["codex", "claude"] as const,
  leader: "codex" as const,
  limit: 7,
  humanInTheLoop: false,
  models: {
    codex: "gpt-5.5",
    claude: "sonnet"
  }
};

const sampleConfig: DebateConfig = {
  debateMode: "multi-cli",
  actors: [
    { cli: "codex", role: "proposer" },
    { cli: "claude", role: "critic" }
  ],
  leader: "codex",
  limit: 7,
  humanInTheLoop: false,
  models: {
    codex: "gpt-5.5",
    claude: "sonnet"
  }
};

test("saveConfig and loadConfig round-trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "debate-config-"));

  try {
    await saveConfig(root, sampleConfig);
    const loaded = await loadConfig(root);

    assert.deepEqual(loaded, sampleConfig);
    const raw = await readFile(configFilePath(root), "utf8");
    assert.match(raw, /"leader": "codex"/);
    assert.doesNotMatch(raw, /"clis"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig returns null when config is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "debate-config-"));

  try {
    assert.equal(await loadConfig(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateLegacyConfig converts clis to peer actors", () => {
  const migrated = migrateLegacyConfig(legacyConfig as DebateConfig);

  assert.deepEqual(migrated.actors, [
    { cli: "codex", role: "peer" },
    { cli: "claude", role: "peer" }
  ]);
  assert.equal(migrated.debateMode, "multi-cli");
});

test("resolveActors assigns unique ids for duplicate cli", () => {
  const actors = resolveActors({
    debateMode: "single-cli",
    actors: [
      { cli: "claude", role: "proposer" },
      { cli: "claude", role: "critic" },
      { cli: "claude", role: "verifier" }
    ],
    leader: "claude",
    limit: 5,
    humanInTheLoop: true,
    models: { claude: "sonnet" }
  });

  assert.equal(actors.length, 3);
  assert.equal(new Set(actors.map((actor) => actor.id)).size, 3);
  assert.match(actors[0].label, /proposer · claude/);
  assert.match(actors[1].label, /critic · claude/);
});

test("validateConfig rejects invalid configs", () => {
  assert.throws(() => validateConfig({ ...sampleConfig, actors: [] }), /at least one actor/);
  assert.throws(() => validateConfig({ ...sampleConfig, leader: "gemini" }), /must match an actor CLI/);
  assert.throws(() => validateConfig({ ...sampleConfig, limit: 0 }), /positive integer/);
  assert.throws(() => validateConfig({ ...sampleConfig, humanInTheLoop: "yes" as unknown as boolean }), /human in the loop/);
  assert.throws(() => validateConfig({ ...sampleConfig, models: { codex: "  " } }), /non-empty model/);
  assert.throws(() => validateConfig({
    ...sampleConfig,
    debateMode: "single-cli",
    actors: [
      { cli: "codex", role: "proposer" },
      { cli: "claude", role: "critic" }
    ]
  }), /all actors to share the same CLI/);
});

test("validateConfig accepts single-cli with one actor or many actors", () => {
  assert.doesNotThrow(() => validateConfig({
    debateMode: "single-cli",
    actors: [{ cli: "claude", role: "proposer" }],
    leader: "claude",
    limit: 5,
    humanInTheLoop: true,
    models: { claude: "sonnet" }
  }));

  const builtinRoles = ["peer", "proposer", "critic", "verifier", "contrarian", "pragmatist"];
  assert.doesNotThrow(() => validateConfig({
    debateMode: "single-cli",
    actors: Array.from({ length: 10 }, (_, index) => ({
      cli: "claude",
      role: builtinRoles[index % builtinRoles.length]
    })),
    leader: "claude",
    limit: 5,
    humanInTheLoop: true,
    models: { claude: "sonnet" }
  }));
});

test("validateResolvedOptions enforces leader membership", () => {
  assert.throws(
    () => validateResolvedOptions({
      actors: resolveActors({
        actors: [{ cli: "claude", role: "peer" }],
        leader: "claude",
        limit: 1,
        humanInTheLoop: false,
        models: { claude: "sonnet" }
      }),
      leader: "codex",
      limit: 1,
      models: {
        claude: "sonnet",
        codex: "gpt-5.5",
        gemini: "flash",
        cursor: "auto"
      }
    }),
    /must match an actor CLI/
  );
});
