import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareVersions,
  detectUpdateCommand,
  fetchLatestVersion,
  getUpdateProposal,
  maybeRunVersionCheck
} from "../src/version-check.ts";
import { MemoryWritable, MockTtyInput, TtyMemoryWritable } from "./helpers/mock-tty.ts";

test("compareVersions orders stable and prerelease semver values", () => {
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.1.0", "1.0.9"), 1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.1.1-alpha.14", "0.1.1-alpha.15"), -1);
  assert.equal(compareVersions("0.1.1-alpha.15", "0.1.1-alpha.14"), 1);
  assert.equal(compareVersions("0.1.1", "0.1.1-alpha.99"), 1);
});

test("getUpdateProposal returns a stale installed version proposal", async () => {
  const root = await createPackageRoot("0.1.1-alpha.14");

  try {
    const proposal = await getUpdateProposal(root, {
      fetchLatestVersion: async () => "0.1.1-alpha.15"
    });

    assert.deepEqual(proposal, {
      currentVersion: "0.1.1-alpha.14",
      latestVersion: "0.1.1-alpha.15",
      updateCommand: {
        command: "npm",
        args: ["install", "-g", "roundtable-cli@latest"],
        display: "npm install -g roundtable-cli@latest"
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getUpdateProposal returns null for current version and failed latest checks", async () => {
  const root = await createPackageRoot("0.1.1-alpha.15");

  try {
    assert.equal(await getUpdateProposal(root, {
      fetchLatestVersion: async () => "0.1.1-alpha.15"
    }), null);

    assert.equal(await getUpdateProposal(root, {
      fetchLatestVersion: async () => null
    }), null);

    assert.equal(await getUpdateProposal(root, {
      fetchLatestVersion: async () => {
        throw new Error("offline");
      }
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fetchLatestVersion handles registry responses and invalid responses", async () => {
  assert.equal(await fetchLatestVersion("roundtable-cli", {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { version: "0.1.2" };
      }
    })
  }), "0.1.2");

  assert.equal(await fetchLatestVersion("roundtable-cli", {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { latest: "0.1.2" };
      }
    })
  }), null);

  assert.equal(await fetchLatestVersion("roundtable-cli", {
    fetchImpl: async () => ({
      ok: false,
      async json() {
        return { version: "0.1.2" };
      }
    })
  }), null);
});

test("detectUpdateCommand chooses npm or pnpm global update commands", () => {
  assert.deepEqual(detectUpdateCommand("/usr/local/lib/node_modules/roundtable-cli"), {
    command: "npm",
    args: ["install", "-g", "roundtable-cli@latest"],
    display: "npm install -g roundtable-cli@latest"
  });

  assert.deepEqual(detectUpdateCommand("/Users/me/.local/share/pnpm/global/5/.pnpm/roundtable-cli@0.1.0/node_modules/roundtable-cli"), {
    command: "pnpm",
    args: ["add", "-g", "roundtable-cli@latest"],
    display: "pnpm add -g roundtable-cli@latest"
  });
});

test("maybeRunVersionCheck asks interactive users and exits after successful update", async () => {
  const root = await createInstallFixture("0.1.1-alpha.14");
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();
  const spawned: string[] = [];

  try {
    const promise = maybeRunVersionCheck({
      entryUrl: pathToFileURL(path.join(root.globalPackage, "dist", "cli.js")).href,
      cwd: root.project,
      input,
      output,
      fetchLatestVersion: async () => "0.1.1-alpha.15",
      spawnImpl(command, args) {
        spawned.push([command, ...args].join(" "));
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child as ChildProcess;
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    input.push("y\n");

    assert.equal(await promise, true);
    assert.deepEqual(spawned, ["npm install -g roundtable-cli@latest"]);
    assert.match(output.text, /Update available: 0\.1\.1-alpha\.14 -> 0\.1\.1-alpha\.15/);
    assert.match(output.text, /Run update now\? npm install -g roundtable-cli@latest \[y\/N\]/);
    assert.match(output.text, /Update complete\. Run roundtable again to continue\./);
  } finally {
    await rm(root.temp, { recursive: true, force: true });
  }
});

test("maybeRunVersionCheck continues when interactive users decline", async () => {
  const root = await createInstallFixture("0.1.1-alpha.14");
  const input = new MockTtyInput();
  const output = new TtyMemoryWritable();
  let spawned = false;

  try {
    const promise = maybeRunVersionCheck({
      entryUrl: pathToFileURL(path.join(root.globalPackage, "dist", "cli.js")).href,
      cwd: root.project,
      input,
      output,
      fetchLatestVersion: async () => "0.1.1-alpha.15",
      spawnImpl() {
        spawned = true;
        throw new Error("should not spawn");
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    input.push("n\n");

    assert.equal(await promise, false);
    assert.equal(spawned, false);
  } finally {
    await rm(root.temp, { recursive: true, force: true });
  }
});

test("maybeRunVersionCheck prints update command without spawning in non-TTY mode", async () => {
  const root = await createInstallFixture("0.1.1-alpha.14");
  const output = new MemoryWritable();

  try {
    const handled = await maybeRunVersionCheck({
      entryUrl: pathToFileURL(path.join(root.globalPackage, "dist", "cli.js")).href,
      cwd: root.project,
      output,
      fetchLatestVersion: async () => "0.1.1-alpha.15",
      spawnImpl() {
        throw new Error("should not spawn");
      }
    });

    assert.equal(handled, false);
    assert.match(output.text, /Update available: 0\.1\.1-alpha\.14 -> 0\.1\.1-alpha\.15/);
    assert.match(output.text, /Update command: npm install -g roundtable-cli@latest/);
  } finally {
    await rm(root.temp, { recursive: true, force: true });
  }
});

test("maybeRunVersionCheck skips source checkout runs", async () => {
  const output = new MemoryWritable();
  let fetched = false;

  const handled = await maybeRunVersionCheck({
    entryUrl: pathToFileURL(path.join(process.cwd(), "src", "cli.ts")).href,
    cwd: process.cwd(),
    output,
    fetchLatestVersion: async () => {
      fetched = true;
      return "9.9.9";
    }
  });

  assert.equal(handled, false);
  assert.equal(fetched, false);
  assert.equal(output.text, "");
});

async function createPackageRoot(version: string): Promise<string> {
  const root = await fsMkdtemp("roundtable-version-root-");
  await writePackageJson(root, version);
  return root;
}

async function createInstallFixture(version: string): Promise<{
  temp: string;
  project: string;
  globalPackage: string;
}> {
  const temp = await fsMkdtemp("roundtable-version-install-");
  const project = path.join(temp, "project");
  const globalPackage = path.join(temp, "lib", "node_modules", "roundtable-cli");
  await mkdir(path.join(globalPackage, "dist"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writePackageJson(globalPackage, version);
  return { temp, project, globalPackage };
}

async function writePackageJson(root: string, version: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "roundtable-cli",
    version
  }), "utf8");
}

async function fsMkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
