import { spawnSync } from "node:child_process";
import { VALID_CLIS, type CliName } from "./types.ts";

export const CLI_COMMANDS: Record<CliName, string> = {
  codex: "codex",
  claude: "claude",
  gemini: "gemini",
  cursor: "agent"
};

export type CommandProbe = (command: string) => boolean;

export function defaultCommandProbe(command: string): boolean {
  const which = spawnSync("which", [command], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return true;
  }

  const version = spawnSync(command, ["--version"], { encoding: "utf8" });
  return version.status === 0;
}

export function discoverAvailableClis(probe: CommandProbe = defaultCommandProbe): CliName[] {
  return VALID_CLIS.filter((cli) => probe(CLI_COMMANDS[cli]));
}

export function requireAvailableClis(probe: CommandProbe = defaultCommandProbe): CliName[] {
  const available = discoverAvailableClis(probe);
  if (available.length === 0) {
    throw new Error([
      "No supported AI CLIs were found on PATH.",
      "Install at least one of: codex, claude, gemini, or agent (Cursor).",
      "Cursor: curl https://cursor.com/install -fsS | bash"
    ].join(" "));
  }

  return available;
}
