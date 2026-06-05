import type { Writable } from "node:stream";
import { configDefaults, migrateLegacyConfig } from "./config.ts";
import { DEFAULT_MODELS, VALID_CLIS, type ActorConfig, type CliName, type CliOptions, type DebateConfig } from "./types.ts";

const VALID_CLI_SET = new Set<string>(VALID_CLIS);
const KNOWN_FLAGS = new Set([
  "clis",
  "limit",
  "leader",
  "human-in-the-loop",
  "claude-model",
  "codex-model",
  "gemini-model",
  "cursor-model",
  "actors",
  "single-cli"
]);

export function wantsHelp(argv: string[]): boolean {
  return argv.length === 0 || argv.some((arg) => arg === "--help" || arg === "-h");
}

export function printHelp(output: Writable = process.stdout): void {
  output.write([
    "Roundtable — orchestrate local AI CLIs on one question",
    "",
    "Usage:",
    '  roundtable "YOUR QUESTION" [options]',
    "",
    "Options:",
    "  --help, -h                         Show this help",
    "  --clis=CLI[,CLI...]                Participants this run (default role: peer)",
    "  --actors=CLI:role[,CLI:role...]    Assign a role per CLI",
    "  --single-cli=CLI:role[,role...]    Multiple roles on one CLI",
    "  --leader=CLI                       Leader CLI (codex, claude, gemini, cursor)",
    "  --limit=N                          Max debate questions (default 5)",
    "  --human-in-the-loop=true|false     Allow one mid-run clarification",
    "  --claude-model=MODEL",
    "  --codex-model=MODEL",
    "  --gemini-model=MODEL",
    "  --cursor-model=MODEL",
    "",
    "Context files:",
    '  roundtable "Review @./docs/plan.md"',
    "",
    "Examples:",
    '  roundtable "Review this launch plan"',
    '  roundtable "Critique this design" --leader=claude --limit=6',
    '  roundtable "Compare ideas" --single-cli=claude:proposer,critic,verifier',
    "",
    "Configuration:",
    "  Global install: ~/.config/roundtable/debate.json",
    "  Project override: ./config/debate.json in the directory you run from.",
    "  Template: config/debate.example.json",
    "  Config id cursor maps to the agent command on PATH.",
    ""
  ].join("\n"));
}

export function parseArgs(
  argv: string[],
  defaults?: DebateConfig,
  options: { warn?: (message: string) => void } = {}
): CliOptions {
  const flags = new Map<string, string>();
  const requestParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--") || arg.startsWith("-")) {
      const normalized = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const separator = normalized.indexOf("=");

      if (separator === -1) {
        const next = argv[index + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`Flag must include a value: ${arg}`);
        }

        flags.set(normalized, next);
        index += 1;
        continue;
      }

      const name = normalized.slice(0, separator);
      const value = normalized.slice(separator + 1);
      flags.set(name, value);
    } else {
      requestParts.push(arg);
    }
  }

  const request = requestParts.join(" ").trim();
  if (!request) {
    throw new Error('Missing question. Run roundtable --help for usage.');
  }

  for (const flag of flags.keys()) {
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown flag: --${flag}`);
    }
  }

  if (flags.has("actors") && flags.has("single-cli")) {
    throw new Error("Use either --actors or --single-cli, not both");
  }

  const fileDefaults = defaults ? configDefaults(migrateLegacyConfig(defaults)) : undefined;
  const models = {
    claude: parseModel(flags.get("claude-model") ?? fileDefaults?.models.claude ?? DEFAULT_MODELS.claude, "claude-model"),
    codex: parseModel(flags.get("codex-model") ?? fileDefaults?.models.codex ?? DEFAULT_MODELS.codex, "codex-model"),
    gemini: parseModel(flags.get("gemini-model") ?? fileDefaults?.models.gemini ?? DEFAULT_MODELS.gemini, "gemini-model"),
    cursor: parseModel(flags.get("cursor-model") ?? fileDefaults?.models.cursor ?? DEFAULT_MODELS.cursor, "cursor-model")
  };

  let actorConfigs: ActorConfig[];
  let leader: CliName;

  if (flags.has("single-cli")) {
    const parsed = parseSingleCliFlag(flags.get("single-cli")!);
    actorConfigs = parsed.actors;
    leader = flags.has("leader") ? parseLeader(flags.get("leader")!) : parsed.cli;
    if (leader !== parsed.cli) {
      throw new Error(`--leader must match the CLI in --single-cli (${parsed.cli})`);
    }
  } else if (flags.has("actors")) {
    actorConfigs = parseActorsFlag(flags.get("actors")!);
    leader = parseLeader(flags.get("leader") ?? fileDefaults?.leader ?? actorConfigs[0]?.cli ?? "codex");
  } else if (flags.has("clis")) {
    const clis = parseCliList(flags.get("clis")!);
    actorConfigs = clis.map((cli) => ({ cli, role: "peer" }));
    leader = parseLeader(flags.get("leader") ?? fileDefaults?.leader ?? clis[0] ?? "codex");
  } else if (fileDefaults) {
    actorConfigs = fileDefaults.actors.map((actor) => ({
      id: actor.id,
      cli: actor.cli,
      role: actor.role,
      model: actor.model,
      behavior: undefined
    }));
    leader = parseLeader(flags.get("leader") ?? fileDefaults.leader);
  } else {
    actorConfigs = ["codex", "claude", "gemini", "cursor"].map((cli) => ({ cli: cli as CliName, role: "peer" }));
    leader = parseLeader(flags.get("leader") ?? "codex");
  }

  const limit = parseLimit(String(flags.get("limit") ?? fileDefaults?.limit ?? 5));
  const humanInTheLoop = parseBoolean(
    flags.get("human-in-the-loop") ?? String(fileDefaults?.humanInTheLoop ?? true),
    "human-in-the-loop"
  );
  const contextRefs = extractContextRefs(request);

  const config: DebateConfig = {
    actors: actorConfigs,
    leader,
    limit,
    humanInTheLoop,
    models: Object.fromEntries(
      [...new Set(actorConfigs.map((actor) => actor.cli))].map((cli) => [cli, models[cli]])
    ),
    customRoles: fileDefaults?.customRoles
  };

  const resolved = configDefaults(config, options);

  return {
    request,
    actors: resolved.actors,
    limit,
    leader,
    humanInTheLoop,
    models,
    contextRefs,
    customRoles: resolved.customRoles
  };
}

export function parseActorsFlag(raw: string): ActorConfig[] {
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("--actors must include at least one cli:role entry");
  }

  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid --actors entry "${entry}". Expected cli:role`);
    }

    const cli = entry.slice(0, separator).trim();
    const role = entry.slice(separator + 1).trim();
    if (!VALID_CLI_SET.has(cli)) {
      throw new Error(`Invalid CLI "${cli}" in --actors. Valid values: ${VALID_CLIS.join(", ")}`);
    }

    if (!role) {
      throw new Error(`Invalid --actors entry "${entry}". Role must not be empty`);
    }

    return { cli: cli as CliName, role };
  });
}

export function parseSingleCliFlag(raw: string): { cli: CliName; actors: ActorConfig[] } {
  const separator = raw.indexOf(":");
  if (separator === -1) {
    throw new Error('--single-cli must be formatted as cli:role[,role,...]');
  }

  const cli = raw.slice(0, separator).trim();
  const rolesPart = raw.slice(separator + 1).trim();
  if (!VALID_CLI_SET.has(cli)) {
    throw new Error(`Invalid CLI "${cli}" in --single-cli. Valid values: ${VALID_CLIS.join(", ")}`);
  }

  const roles = rolesPart.split(",").map((role) => role.trim()).filter(Boolean);
  if (roles.length < 1) {
    throw new Error("--single-cli requires at least one role");
  }

  return {
    cli: cli as CliName,
    actors: roles.map((role) => ({ cli: cli as CliName, role }))
  };
}

export function extractContextRefs(request: string): string[] {
  const refs = new Set<string>();
  const explicitRefRegex = /(?:^|\s)@([^\s]+)/g;
  const relativeFileRegex = /(?:^|\s)\.\/([^\s),;:!?]+)/g;
  const absoluteFileRegex = /(?:^|\s)(\/[^\s),;:!?]+)/g;
  let match: RegExpExecArray | null;

  while ((match = explicitRefRegex.exec(request)) !== null) {
    refs.add(stripTrailingPunctuation(match[1]));
  }

  while ((match = relativeFileRegex.exec(request)) !== null) {
    refs.add(`./${stripTrailingPunctuation(match[1])}`);
  }

  while ((match = absoluteFileRegex.exec(request)) !== null) {
    refs.add(stripTrailingPunctuation(match[1]));
  }

  return [...refs];
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),;:!?]+$/g, "");
}

function parseCliList(raw: string): CliName[] {
  const names = raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error("--clis must include at least one CLI");
  }

  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!VALID_CLI_SET.has(name)) {
      throw new Error(`Invalid CLI "${name}". Valid values: ${VALID_CLIS.join(", ")}`);
    }
  }

  return unique as CliName[];
}

function parseLeader(raw: string): CliName {
  if (!VALID_CLI_SET.has(raw)) {
    throw new Error(`Invalid leader "${raw}". Valid values: ${VALID_CLIS.join(", ")}`);
  }

  return raw as CliName;
}

function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error("--limit must be a positive integer");
  }

  const limit = Number(raw);
  if (limit < 1) {
    throw new Error("--limit must be at least 1");
  }

  return limit;
}

function parseBoolean(raw: string, flag: string): boolean {
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  throw new Error(`--${flag} must be true or false`);
}

function parseModel(raw: string, flag: string): string {
  const model = raw.trim();
  if (!model) {
    throw new Error(`--${flag} must not be empty`);
  }

  return model;
}
