#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { discoverAvailableClis } from "./cli-discovery.ts";
import { loadConfig, saveConfig, validateResolvedOptions } from "./config.ts";
import { parseArgs, printHelp, wantsHelp } from "./parser.ts";
import { loadContextReferences } from "./context.ts";
import { createAdapter } from "./adapters.ts";
import { DebateEngine } from "./engine.ts";
import { confirmExistingConfig, runSetupTui } from "./setup-tui.ts";
import { uniqueClis } from "./types.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (wantsHelp(argv)) {
    printHelp();
    return;
  }

  const rootDir = process.cwd();
  let fileConfig = await loadConfig(rootDir);
  let shouldSaveConfig = false;

  if (!fileConfig) {
    fileConfig = await runSetupTui(rootDir);
    shouldSaveConfig = true;
  } else {
    const startup = await confirmExistingConfig(rootDir, fileConfig);
    fileConfig = startup.config;
    shouldSaveConfig = startup.setupFromScratch;
  }

  if (shouldSaveConfig) {
    await saveConfig(rootDir, fileConfig);
  }

  const options = parseArgs(argv, fileConfig, {
    warn: (message) => process.stderr.write(`[roundtable] Warning: ${message}\n`)
  });
  validateResolvedOptions(options);

  const requiredClis = uniqueClis(options.actors);
  const missingClis = requiredClis.filter((cli) => !discoverAvailableClis().includes(cli));
  if (missingClis.length > 0) {
    throw new Error([
      `Configured CLIs are not available on PATH: ${missingClis.join(", ")}`,
      "Delete config/debate.json and run roundtable again to reconfigure."
    ].join(" "));
  }

  const contexts = await loadContextReferences(options.contextRefs);
  const engine = new DebateEngine({
    rootDir,
    request: options.request,
    actors: options.actors,
    limit: options.limit,
    leader: options.leader,
    humanInTheLoop: options.humanInTheLoop,
    models: options.models,
    contexts,
    leaderAdapter: createAdapter(options.leader, options.models[options.leader]),
    createActorAdapter: (actor) => createAdapter(actor.cli, actor.model),
    output: process.stdout
  });

  const result = await engine.run();
  process.stdout.write([
    "",
    "[roundtable] Status: complete",
    `[roundtable] Report: ${result.reportPath}`,
    `[roundtable] Logs: ${result.logPath}`,
    ""
  ].join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
