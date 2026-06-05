import { spawnSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { CLI_COMMANDS, defaultCommandProbe, requireAvailableClis, type CommandProbe } from "../cli-discovery.ts";
import { inferDebateMode, type DebateConfig } from "../config.ts";
import { builtinRoleOptions, validateCustomRoleName } from "../roles.ts";
import { DEFAULT_MODELS, type ActorConfig, type CliName } from "../types.ts";
import { CLI_HINTS, ROLE_HINTS, SUGGESTED_MODELS } from "./copy.ts";
import { SetupTui, colorCli } from "./setup-tui.ts";

export interface SetupTuiDeps {
  input?: Readable;
  output?: Writable;
  probe?: CommandProbe;
  listCursorModels?: () => string[];
}

export interface StartupConfigChoice {
  config: DebateConfig;
  setupFromScratch: boolean;
}

export function formatConfigSummary(config: DebateConfig): string[] {
  return formatSummary(config);
}

export async function confirmExistingConfig(
  rootDir: string,
  existing: DebateConfig,
  deps: SetupTuiDeps = {}
): Promise<StartupConfigChoice> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const interactive = Boolean((output as Writable & { isTTY?: boolean }).isTTY);

  if (!interactive) {
    return { config: existing, setupFromScratch: false };
  }

  const ui = new SetupTui(input, output);

  try {
    const choice = await ui.selectWithBody(
      "Existing configuration",
      "Reuse saved actors, models, and limits, or walk through setup again.",
      formatSummary(existing),
      [
        {
          label: "Use existing configuration",
          value: "use",
          selected: true,
          detail: "Start debating immediately with the settings shown above."
        },
        {
          label: "Setup from scratch",
          value: "setup",
          detail: "Reconfigure actors, models, leader, and limits; saved on confirm."
        }
      ]
    );

    if (choice === "use") {
      return { config: existing, setupFromScratch: false };
    }

    ui.close();
    const config = await runSetupTui(rootDir, deps);
    return { config, setupFromScratch: true };
  } finally {
    ui.close();
  }
}

export async function runSetupTui(_rootDir: string, deps: SetupTuiDeps = {}): Promise<DebateConfig> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const interactive = Boolean((output as Writable & { isTTY?: boolean }).isTTY);

  if (!interactive) {
    throw new Error([
      "First-time setup requires an interactive terminal.",
      "Run roundtable from a TTY to configure CLIs and models, or copy config/debate.example.json to config/debate.json."
    ].join(" "));
  }

  const probe = deps.probe ?? defaultCommandProbe;
  const available = requireAvailableClis(probe);
  const ui = new SetupTui(input, output);

  try {
    const customRoles: Record<string, string> = {};
    const actorCount = await ui.readActorCount(3);
    const actors: ActorConfig[] = [];

    for (let index = 0; index < actorCount; index += 1) {
      actors.push(await setupActor(ui, index, actorCount, available, customRoles, deps.listCursorModels));
    }

    const actorClis = [...new Set(actors.map((actor) => actor.cli))];
    const defaultLeader = actorClis.includes("codex") ? "codex" : actorClis[0];
    const leader = await ui.select(
      "Select leader",
      "The leader asks each round's question and writes the final synthesis.",
      actorClis.map((cli) => ({
        label: colorCli(cli),
        value: cli,
        selected: cli === defaultLeader,
        detail: `${cli} orchestrates rounds, compacts debate memory, and produces the report.`
      }))
    );

    const limit = await ui.readLimit(5);
    const humanInTheLoop = await ui.selectBoolean(
      "Human in the loop",
      true,
      "Whether the leader may pause mid-debate to ask you one clarifying question.",
      "Leader may ask you one clarifying question before continuing.",
      "Fully autonomous; no prompts while the debate runs."
    );
    const config: DebateConfig = {
      debateMode: inferDebateMode(actors),
      actors,
      leader,
      limit,
      humanInTheLoop,
      models: buildModelsFromActors(actors),
      ...(Object.keys(customRoles).length > 0 ? { customRoles } : {})
    };

    await ui.confirm(
      "Save configuration",
      "Review the settings below. Press Enter to write config/debate.json.",
      formatSummary(config)
    );
    return config;
  } finally {
    ui.close();
  }
}

export function modelOptionsFor(cli: CliName, listCursorModels?: () => string[]): Array<{ label: string; value: string }> {
  const values = new Set<string>(SUGGESTED_MODELS[cli]);
  values.add(DEFAULT_MODELS[cli]);

  if (cli === "cursor") {
    for (const model of (listCursorModels ?? listCursorModelsFromAgent)()) {
      values.add(model);
    }
  }

  const options = [...values].map((value) => ({ label: value, value }));
  options.push({ label: "Custom...", value: "__custom__" });
  return options;
}

export function listCursorModelsFromAgent(): string[] {
  const result = spawnSync("agent", ["--list-models"], { encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }

  return [...new Set(
    `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("Usage"))
  )];
}

async function pickModel(ui: SetupTui, cli: CliName, listCursorModels?: () => string[]): Promise<string> {
  const options = modelOptionsFor(cli, listCursorModels);
  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === DEFAULT_MODELS[cli]));
  const choice = await ui.select(
    `Model for ${colorCli(cli)}`,
    "Model id passed to the CLI; affects answer quality, speed, and cost.",
    options.map((option, index) => ({
      ...option,
      selected: index === defaultIndex,
      detail: option.value === "__custom__"
        ? "Type any model id supported by this CLI."
        : `Uses ${option.value} for this actor's subprocess.`
    }))
  );

  if (choice === "__custom__") {
    return ui.readLine(
      `Enter model id for ${cli}`,
      DEFAULT_MODELS[cli],
      "Any model id accepted by this CLI; check its docs for valid values."
    );
  }

  return choice;
}

async function setupActor(
  ui: SetupTui,
  index: number,
  total: number,
  available: CliName[],
  customRoles: Record<string, string>,
  listCursorModels?: () => string[]
): Promise<ActorConfig> {
  const title = `Actor ${index + 1} of ${total}`;
  const cli = await ui.select(
    title,
    "Each actor runs as its own subprocess using the selected local CLI.",
    available.map((item, itemIndex) => ({
      label: `${colorCli(item)} (${CLI_COMMANDS[item]})`,
      value: item,
      selected: itemIndex === 0,
      detail: CLI_HINTS[item]
    }))
  );

  const model = await pickModel(ui, cli, listCursorModels);
  const roleChoice = await pickRole(ui, customRoles);
  return { cli, model, ...roleChoice };
}

function buildModelsFromActors(actors: ActorConfig[]): Partial<Record<CliName, string>> {
  const models: Partial<Record<CliName, string>> = {};
  const seen = new Set<CliName>();

  for (const actor of actors) {
    if (!seen.has(actor.cli) && actor.model) {
      seen.add(actor.cli);
      models[actor.cli] = actor.model;
    }
  }

  return models;
}

async function pickRole(
  ui: SetupTui,
  customRoles: Record<string, string>
): Promise<Pick<ActorConfig, "role" | "behavior">> {
  const savedCustom = Object.keys(customRoles).map((name) => ({
    label: titleCase(name),
    value: name
  }));

  const choice = await ui.select(
    "Role",
    "Role shapes how this actor argues — tone, goals, and what it challenges.",
    [
      ...builtinRoleOptions().map((role, index) => ({
        label: role.name,
        value: role.id,
        selected: index === 0,
        detail: ROLE_HINTS[role.id]
      })),
      ...savedCustom.map((item) => ({
        label: `${item.label} (custom)`,
        value: item.value,
        detail: "Reuses behavioral instructions saved earlier in this setup."
      })),
      { label: "Custom inline...", value: "__custom__", detail: ROLE_HINTS.__custom__ }
    ]
  );

  if (choice === "__custom__") {
    return addCustomRole(ui, customRoles);
  }

  if (customRoles[choice]) {
    return { role: choice };
  }

  return { role: choice };
}

async function addCustomRole(ui: SetupTui, customRoles: Record<string, string>): Promise<Pick<ActorConfig, "role" | "behavior">> {
  const name = await ui.readLine(
    "Custom role id (lowercase, hyphens ok)",
    "custom-role",
    "Short identifier used in config and reports, e.g. security-auditor."
  );
  validateCustomRoleName(name);
  const behavior = await ui.readLine(
    "Behavioral instructions for this role",
    "Challenge assumptions and stay in character.",
    "How this actor should argue — tone, focus, and what to challenge."
  );
  const save = await ui.selectBoolean(
    "Save as reusable custom role?",
    true,
    "Saved roles appear in the role picker for later actors in this setup.",
    "Store instructions in config for reuse by other actors.",
    "Use instructions for this actor only; not added to config."
  );
  if (save) {
    customRoles[name] = behavior;
    return { role: name };
  }

  return { role: name, behavior };
}

function formatSummary(config: DebateConfig): string[] {
  const mode = config.debateMode ?? inferDebateMode(config.actors);
  const lines = [
    `Mode: ${mode} (inferred)`,
    `Actors: ${config.actors.length}`,
    ...config.actors.map((actor, index) => {
      const model = actor.model ?? config.models[actor.cli];
      return `  ${index + 1}. ${actor.role} · ${colorCli(actor.cli)}${model ? ` (${model})` : ""}`;
    }),
    `Leader: ${colorCli(config.leader)}`,
    `Limit: ${config.limit}`,
    `Human in the loop: ${config.humanInTheLoop}`,
    `Parallel subprocesses per round: up to ${config.actors.length + 1} (${config.actors.length} actors + leader)`
  ];

  if (config.customRoles && Object.keys(config.customRoles).length > 0) {
    lines.push(`Custom roles: ${Object.keys(config.customRoles).join(", ")}`);
  }

  return lines;
}

function titleCase(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
