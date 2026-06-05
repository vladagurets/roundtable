import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { sep } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { isGlobalInstall, resolvePackageRoot } from "./config-root.ts";

const PACKAGE_NAME = "roundtable-cli";
const DEFAULT_TIMEOUT_MS = 800;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

type SpawnLike = (command: string, args: string[], options: { stdio: "inherit" }) => ChildProcess;

export interface UpdateCommand {
  command: string;
  args: string[];
  display: string;
}

export interface UpdateProposal {
  currentVersion: string;
  latestVersion: string;
  updateCommand: UpdateCommand;
}

export interface VersionCheckDeps {
  entryUrl: string;
  cwd?: string;
  input?: Readable;
  output?: Writable;
  fetchLatestVersion?: (packageName: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  timeoutMs?: number;
}

export async function maybeRunVersionCheck(deps: VersionCheckDeps): Promise<boolean> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const packageRoot = resolvePackageRoot(deps.entryUrl);

  if (!(await isGlobalInstall(packageRoot, deps.cwd))) {
    return false;
  }

  const proposal = await getUpdateProposal(packageRoot, {
    fetchLatestVersion: deps.fetchLatestVersion,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs
  });
  if (!proposal) {
    return false;
  }

  output.write(`[roundtable] Update available: ${proposal.currentVersion} -> ${proposal.latestVersion}\n`);
  const interactive = Boolean(
    (input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY
  );

  if (!interactive) {
    output.write(`[roundtable] Update command: ${proposal.updateCommand.display}\n`);
    return false;
  }

  if (!(await confirmUpdate(input, output, proposal.updateCommand.display))) {
    return false;
  }

  const updated = await runUpdateCommand(proposal.updateCommand, deps.spawnImpl ?? spawn);
  const installedVersion = updated ? await readCurrentVersion(packageRoot) : null;
  if (!updated || !installedVersion || compareVersions(installedVersion, proposal.latestVersion) < 0) {
    output.write("[roundtable] Update failed. Continuing with the current version.\n");
    output.write(`[roundtable] Try running manually: ${proposal.updateCommand.display}\n`);
    return false;
  }

  output.write("[roundtable] Update complete. Run roundtable again to continue.\n");
  return true;
}

export async function getUpdateProposal(
  packageRoot: string,
  deps: {
    fetchLatestVersion?: (packageName: string) => Promise<string | null>;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {}
): Promise<UpdateProposal | null> {
  const currentVersion = await readCurrentVersion(packageRoot);
  if (!currentVersion) {
    return null;
  }

  const latestVersion = deps.fetchLatestVersion
    ? await safeFetchLatestVersion(() => deps.fetchLatestVersion!(PACKAGE_NAME))
    : await fetchLatestVersion(PACKAGE_NAME, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs
    });
  if (!latestVersion || compareVersions(currentVersion, latestVersion) >= 0) {
    return null;
  }

  return {
    currentVersion,
    latestVersion,
    updateCommand: detectUpdateCommand(packageRoot, latestVersion)
  };
}

export async function fetchLatestVersion(
  packageName: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return null;
  }

  return safeFetchLatestVersion(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }

      const body = await response.json();
      if (!isRegistryPackage(body)) {
        return null;
      }

      return body.version;
    } finally {
      clearTimeout(timeout);
    }
  });
}

export function detectUpdateCommand(packageRoot: string, version = "latest"): UpdateCommand {
  const spec = `${PACKAGE_NAME}@${version}`;
  const isPnpm = packageRoot.includes(`${sep}.pnpm${sep}`) || packageRoot.includes(`${sep}pnpm${sep}`);
  if (isPnpm) {
    return {
      command: "pnpm",
      args: ["add", "-g", spec],
      display: `pnpm add -g ${spec}`
    };
  }

  return {
    command: "npm",
    args: ["install", "-g", spec],
    display: `npm install -g ${spec}`
  };
}

export async function readCurrentVersion(packageRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(`${packageRoot}/package.json`, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPackageJson(parsed) || parsed.name !== PACKAGE_NAME || !parseSemver(parsed.version)) {
      return null;
    }

    return parsed.version;
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  for (const key of ["major", "minor", "patch"] as const) {
    const delta = parsedLeft[key] - parsedRight[key];
    if (delta !== 0) {
      return Math.sign(delta);
    }
  }

  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

async function safeFetchLatestVersion(fetcher: () => Promise<string | null>): Promise<string | null> {
  try {
    const version = await fetcher();
    return version && parseSemver(version) ? version : null;
  } catch {
    return null;
  }
}

async function confirmUpdate(input: Readable, output: Writable, updateCommand: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`[roundtable] Run update now? ${updateCommand} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function runUpdateCommand(updateCommand: UpdateCommand, spawnImpl: SpawnLike): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnImpl(updateCommand.command, updateCommand.args, { stdio: "inherit" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function isRegistryPackage(value: unknown): value is { version: string } {
  return typeof value === "object" && value !== null && typeof (value as { version?: unknown }).version === "string";
}

function isPackageJson(value: unknown): value is { name: string; version: string } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { version?: unknown }).version === "string";
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = numericPrereleasePart(leftPart);
    const rightNumeric = numericPrereleasePart(rightPart);
    if (leftNumeric !== null && rightNumeric !== null) {
      return Math.sign(leftNumeric - rightNumeric);
    }
    if (leftNumeric !== null) {
      return -1;
    }
    if (rightNumeric !== null) {
      return 1;
    }

    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function numericPrereleasePart(value: string): number | null {
  return /^(0|[1-9]\d*)$/.test(value) ? Number(value) : null;
}
