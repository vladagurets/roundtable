import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { MemoryWritable } from "./helpers/mock-tty.ts";

test("main runs version check before help and exits when update handled", async () => {
  const output = new MemoryWritable();
  const calls: string[] = [];

  await main(["--help"], {
    output,
    versionCheck: async () => {
      calls.push("version-check");
      return true;
    }
  });

  assert.deepEqual(calls, ["version-check"]);
  assert.equal(output.text, "");
});

test("main continues to help when version check does not handle startup", async () => {
  const output = new MemoryWritable();
  const calls: string[] = [];

  await main(["--help"], {
    output,
    versionCheck: async () => {
      calls.push("version-check");
      return false;
    }
  });

  assert.deepEqual(calls, ["version-check"]);
  assert.match(output.text, /Roundtable/);
  assert.match(output.text, /--help/);
});
