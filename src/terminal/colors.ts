import { RESET } from "../tui-frame.ts";
import type { CliName } from "../types.ts";

export const CLI_COLORS: Record<CliName, string> = {
  codex: "\u001b[38;5;117m",
  claude: "\u001b[38;5;210m",
  gemini: "\u001b[38;5;120m",
  cursor: "\u001b[38;5;141m"
};

export function colorCli(cli: CliName): string {
  return `${CLI_COLORS[cli]}${cli}${RESET}`;
}
