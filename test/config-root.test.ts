import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  configExistsAt,
  isGlobalInstall,
  resolveConfigFilePath,
  resolvePackageRoot
} from "../src/config-root.ts";
import { configFilePath, globalConfigFilePath } from "../src/config.ts";

test("resolvePackageRoot finds repo root from src entry", () => {
  const entryUrl = pathToFileURL(path.join(process.cwd(), "src", "cli.ts")).href;
  assert.equal(resolvePackageRoot(entryUrl), process.cwd());
});

test("configExistsAt detects saved config", async () => {
  const root = await fsMkdtemp("debate-config-root-");

  try {
    const configPath = configFilePath(root);
    assert.equal(await configExistsAt(configPath), false);
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(configPath, "{}", "utf8");
    assert.equal(await configExistsAt(configPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isGlobalInstall detects package outside cwd in node_modules", async () => {
  const root = await fsMkdtemp("debate-global-");
  const project = path.join(root, "project");
  const globalPackage = path.join(root, "lib", "node_modules", "roundtable-cli");

  try {
    await mkdir(project, { recursive: true });
    await mkdir(globalPackage, { recursive: true });
    assert.equal(await isGlobalInstall(globalPackage, project), true);
    assert.equal(await isGlobalInstall(project, project), false);
    assert.equal(await isGlobalInstall(path.join(project, "node_modules", "roundtable-cli"), project), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveConfigFilePath prefers project config over user config", async () => {
  const root = await fsMkdtemp("debate-resolve-");
  const project = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const globalPackage = path.join(root, "lib", "node_modules", "roundtable-cli");
  const entryUrl = pathToFileURL(path.join(globalPackage, "dist", "cli.js")).href;

  try {
    await mkdir(path.join(project, "config"), { recursive: true });
    await mkdir(path.join(homeDir, ".config", "roundtable"), { recursive: true });
    await writeFile(configFilePath(project), "{}", "utf8");
    await writeFile(globalConfigFilePath(homeDir), "{}", "utf8");
    await mkdir(path.join(globalPackage, "dist"), { recursive: true });

    assert.equal(
      await resolveConfigFilePath({ entryUrl, cwd: project, homeDir }),
      configFilePath(project)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveConfigFilePath uses user config for global install", async () => {
  const root = await fsMkdtemp("debate-resolve-global-");
  const project = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const globalPackage = path.join(root, "lib", "node_modules", "roundtable-cli");
  const entryUrl = pathToFileURL(path.join(globalPackage, "dist", "cli.js")).href;

  try {
    await mkdir(project, { recursive: true });
    await mkdir(path.join(globalPackage, "dist"), { recursive: true });

    assert.equal(
      await resolveConfigFilePath({ entryUrl, cwd: project, homeDir }),
      globalConfigFilePath(homeDir)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveConfigFilePath uses existing user config for source installs", async () => {
  const root = await fsMkdtemp("debate-resolve-user-");
  const project = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const entryUrl = pathToFileURL(path.join(process.cwd(), "src", "cli.ts")).href;

  try {
    await mkdir(project, { recursive: true });
    await mkdir(path.join(homeDir, ".config", "roundtable"), { recursive: true });
    await writeFile(globalConfigFilePath(homeDir), "{}", "utf8");

    assert.equal(
      await resolveConfigFilePath({ entryUrl, cwd: project, homeDir }),
      globalConfigFilePath(homeDir)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveConfigFilePath uses cwd for source installs without user config", async () => {
  const root = await fsMkdtemp("debate-resolve-source-");
  const project = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const entryUrl = pathToFileURL(path.join(process.cwd(), "src", "cli.ts")).href;

  try {
    await mkdir(project, { recursive: true });

    assert.equal(
      await resolveConfigFilePath({ entryUrl, cwd: project, homeDir }),
      configFilePath(project)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fsMkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
