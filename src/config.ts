import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isBuiltinRoleId, resolveRoleBehavior, roleDisplayName } from "./roles.ts";
import {
  DEFAULT_MODELS,
  VALID_CLIS,
  type ActorConfig,
  type CliName,
  type CliModels,
  type CliOptions,
  type DebateConfig,
  type DebateMode,
  type ResolvedActor,
  uniqueClis
} from "./types.ts";

export type { DebateConfig };

export const CONFIG_FILENAME = "debate.json";

const VALID_CLI_SET = new Set<string>(VALID_CLIS);

export function configFilePath(rootDir: string): string {
  return join(rootDir, "config", CONFIG_FILENAME);
}

export function globalConfigFilePath(homeDir = homedir()): string {
  return join(homeDir, ".config", "roundtable", CONFIG_FILENAME);
}

export function migrateLegacyConfig(raw: DebateConfig): DebateConfig {
  if (Array.isArray(raw.actors) && raw.actors.length > 0) {
    return raw;
  }

  const legacyClis = raw.clis;
  if (!Array.isArray(legacyClis) || legacyClis.length === 0) {
    throw new Error("Config must include at least one actor or legacy clis entry");
  }

  return {
    ...raw,
    debateMode: legacyClis.length === 1 ? "single-cli" : "multi-cli",
    actors: legacyClis.map((cli) => ({ cli, role: "peer" }))
  };
}

export function validateConfig(config: DebateConfig): void {
  const migrated = migrateLegacyConfig(config);

  if (!Array.isArray(migrated.actors) || migrated.actors.length === 0) {
    throw new Error("Config must include at least one actor");
  }

  for (const actor of migrated.actors) {
    if (!VALID_CLI_SET.has(actor.cli)) {
      throw new Error(`Invalid CLI "${actor.cli}" in config. Valid values: ${VALID_CLIS.join(", ")}`);
    }

    if (!actor.role?.trim()) {
      throw new Error(`Actor on ${actor.cli} must include a role`);
    }
  }

  if (!VALID_CLI_SET.has(migrated.leader)) {
    throw new Error(`Invalid leader "${migrated.leader}" in config`);
  }

  const actorClis = migrated.actors.map((actor) => actor.cli);
  if (!actorClis.includes(migrated.leader)) {
    throw new Error(`Leader "${migrated.leader}" must match an actor CLI`);
  }

  if (!Number.isInteger(migrated.limit) || migrated.limit < 1) {
    throw new Error("Config limit must be a positive integer");
  }

  if (typeof migrated.humanInTheLoop !== "boolean") {
    throw new Error('Config "human in the loop" must be true or false');
  }

  if (!migrated.models || typeof migrated.models !== "object") {
    throw new Error("Config models must be an object");
  }

  if (migrated.leaderModel !== undefined && !migrated.leaderModel.trim()) {
    throw new Error("Config leaderModel must be a non-empty model");
  }

  for (const cli of uniqueClis(resolveActors(migrated))) {
    const model = migrated.models[cli]?.trim();
    if (!model) {
      throw new Error(`Config must include a non-empty model for ${cli}`);
    }
  }

  if (migrated.debateMode === "single-cli") {
    const clis = new Set(migrated.actors.map((actor) => actor.cli));
    if (clis.size !== 1) {
      throw new Error("single-cli debateMode requires all actors to share the same CLI");
    }
  }
}

export function resolveActors(config: DebateConfig, options: { warn?: (message: string) => void } = {}): ResolvedActor[] {
  const migrated = migrateLegacyConfig(config);
  const models = configToCliModels(migrated);
  const customRoles = migrated.customRoles ?? {};
  const resolved: ResolvedActor[] = [];
  const idCounts = new Map<string, number>();
  const roleCliCounts = new Map<string, number>();
  const builtinRoleCounts = new Map<string, number>();

  for (const actor of migrated.actors) {
    const behavior = resolveRoleBehavior(actor.role, customRoles, actor.behavior);
    const roleName = roleDisplayName(actor.role, customRoles);
    const model = actor.model?.trim() || models[actor.cli];

    const baseId = actor.id?.trim() || `${actor.role}-${actor.cli}`;
    const seen = idCounts.get(baseId) ?? 0;
    idCounts.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;

    const roleCliKey = `${actor.role}:${actor.cli}`;
    const roleCliSeen = roleCliCounts.get(roleCliKey) ?? 0;
    roleCliCounts.set(roleCliKey, roleCliSeen + 1);
    const suffix = roleCliSeen === 0 ? "" : ` #${roleCliSeen + 1}`;
    const label = `${roleName.toLowerCase()} · ${actor.cli}${suffix}`;

    if (isBuiltinRoleId(actor.role)) {
      const count = (builtinRoleCounts.get(actor.role) ?? 0) + 1;
      builtinRoleCounts.set(actor.role, count);
      if (count === 2) {
        const scope = migrated.debateMode === "single-cli" ? "single-cli config" : "config";
        options.warn?.(`Duplicate built-in role "${actor.role}" in ${scope}.`);
      }
    }

    resolved.push({
      id,
      cli: actor.cli,
      role: actor.role,
      roleName,
      model,
      behavior,
      label
    });
  }

  const ids = resolved.map((actor) => actor.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Resolved actor ids must be unique");
  }

  return resolved;
}

export function configToCliModels(config: DebateConfig): CliModels {
  const migrated = migrateLegacyConfig(config);
  const clis = uniqueClis(migrated.actors.map((actor) => ({ cli: actor.cli })));

  return {
    ...DEFAULT_MODELS,
    ...Object.fromEntries(
      clis.map((cli) => [cli, migrated.models[cli]?.trim() || DEFAULT_MODELS[cli]])
    )
  } as CliModels;
}

export function leaderModelForConfig(config: DebateConfig): string {
  const migrated = migrateLegacyConfig(config);
  const models = configToCliModels(migrated);
  return migrated.leaderModel?.trim() || models[migrated.leader];
}

export function configDefaults(
  config: DebateConfig,
  options: { warn?: (message: string) => void } = {}
): Omit<CliOptions, "request" | "contextRefs"> {
  const migrated = migrateLegacyConfig(config);

  return {
    actors: resolveActors(migrated, options),
    leader: migrated.leader,
    leaderModel: leaderModelForConfig(migrated),
    limit: migrated.limit,
    humanInTheLoop: migrated.humanInTheLoop,
    models: configToCliModels(migrated),
    customRoles: migrated.customRoles
  };
}

export function validateResolvedOptions(options: Pick<CliOptions, "actors" | "leader" | "leaderModel" | "limit" | "models">): void {
  if (options.actors.length === 0) {
    throw new Error("At least one actor must be configured");
  }

  const actorClis = options.actors.map((actor) => actor.cli);
  if (!actorClis.includes(options.leader)) {
    throw new Error(`Leader "${options.leader}" must match an actor CLI`);
  }

  if (!options.leaderModel.trim()) {
    throw new Error("Leader model must not be empty");
  }

  for (const cli of uniqueClis(options.actors)) {
    const model = options.models[cli]?.trim();
    if (!model) {
      throw new Error(`Model for ${cli} must not be empty`);
    }
  }
}

export function normalizeConfigForSave(config: DebateConfig): DebateConfig {
  const migrated = migrateLegacyConfig(config);
  const { clis: _legacy, ...rest } = migrated;
  return rest;
}

export async function loadConfigFile(configPath: string): Promise<DebateConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid config file at ${configPath}: expected JSON`);
  }

  const config = migrateLegacyConfig(parsed as DebateConfig);
  validateConfig(config);
  return config;
}

export async function loadConfig(rootDir: string): Promise<DebateConfig | null> {
  return loadConfigFile(configFilePath(rootDir));
}

export async function saveConfigFile(configPath: string, config: DebateConfig): Promise<void> {
  const normalized = normalizeConfigForSave(config);
  validateConfig(normalized);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function saveConfig(rootDir: string, config: DebateConfig): Promise<void> {
  await saveConfigFile(configFilePath(rootDir), config);
}

export function inferDebateMode(actors: ActorConfig[]): DebateMode {
  const clis = new Set(actors.map((actor) => actor.cli));
  return clis.size === 1 && actors.length > 1 ? "single-cli" : "multi-cli";
}
