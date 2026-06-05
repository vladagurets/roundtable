import test from "node:test";
import assert from "node:assert/strict";
import { CLI_COMMANDS, discoverAvailableClis, requireAvailableClis } from "../src/cli-discovery.ts";

test("discovers available CLIs through injected probe", () => {
  const probe = (command: string) => command === "claude" || command === "agent";
  assert.deepEqual(discoverAvailableClis(probe), ["claude", "cursor"]);
  assert.equal(CLI_COMMANDS.cursor, "agent");
});

test("requireAvailableClis throws when nothing is installed", () => {
  assert.throws(
    () => requireAvailableClis(() => false),
    /No supported AI CLIs were found/
  );
});

test("requireAvailableClis returns discovered CLIs", () => {
  assert.deepEqual(
    requireAvailableClis((command) => command === "codex"),
    ["codex"]
  );
});
