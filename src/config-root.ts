import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configFilePath, globalConfigFilePath } from "./config.ts";

export function resolvePackageRoot(entryUrl: string): string {
  const entryPath = fileURLToPath(entryUrl);
  return resolve(dirname(entryPath), "..");
}

export async function configExistsAt(configPath: string): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

export async function isGlobalInstall(packageRoot: string, cwd = process.cwd()): Promise<boolean> {
  const resolvedPackageRoot = await tryRealpath(packageRoot);
  const resolvedCwd = await tryRealpath(cwd);
  const pathFromCwd = relative(resolvedCwd, resolvedPackageRoot);

  if (pathFromCwd === "" || (!pathFromCwd.startsWith("..") && !isAbsolute(pathFromCwd))) {
    return false;
  }

  return resolvedPackageRoot.includes(`${sep}node_modules${sep}roundtable-cli`);
}

async function tryRealpath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const absolute = resolve(target);
  let current = absolute;
  const suffix: string[] = [];

  while (true) {
    try {
      const root = await realpath(current);
      return suffix.length === 0 ? root : join(root, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    suffix.push(basename(current));
    const parent = dirname(current);
    if (parent === current) {
      return absolute;
    }

    current = parent;
  }
}

export async function resolveConfigFilePath(options: {
  entryUrl: string;
  cwd?: string;
  homeDir?: string;
}): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = options.homeDir ?? homedir();
  const projectConfigPath = configFilePath(cwd);
  const userConfigPath = globalConfigFilePath(homeDir);
  const packageRoot = resolvePackageRoot(options.entryUrl);

  if (await configExistsAt(projectConfigPath)) {
    return projectConfigPath;
  }

  if (await configExistsAt(userConfigPath)) {
    return userConfigPath;
  }

  if (await isGlobalInstall(packageRoot, cwd)) {
    return userConfigPath;
  }

  return projectConfigPath;
}
