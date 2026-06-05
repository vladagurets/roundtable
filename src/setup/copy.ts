import type { CliName } from "../types.ts";

export const CLI_HINTS: Record<CliName, string> = {
  codex: "OpenAI Codex CLI — strong reasoning; common default for the leader.",
  claude: "Anthropic Claude CLI — long-context analysis and careful critique.",
  gemini: "Google Gemini CLI — fast responses; cost-effective for many actors.",
  cursor: "Cursor agent CLI — uses models from your editor installation."
};

export const ROLE_HINTS: Record<string, string> = {
  peer: "Neutral challenger; improves reasoning without claiming authority.",
  proposer: "Commits to a clear position and defends it with explicit reasoning.",
  critic: "Breaks the strongest argument; finds gaps, edge cases, and counterexamples.",
  verifier: "Audits factual claims; marks verified, unverified, or likely wrong.",
  contrarian: "Steelmans the least popular position the group may be overlooking.",
  pragmatist: "Translates debate into feasibility, cost, and concrete next steps.",
  __custom__: "Define one-off behavioral instructions without saving to config."
};

export const SUGGESTED_MODELS: Record<CliName, string[]> = {
  codex: ["gpt-5.5"],
  claude: ["sonnet", "opus"],
  gemini: ["gemini-2.5-flash", "gemini-3-flash-preview"],
  cursor: ["auto", "composer-2.5"]
};
