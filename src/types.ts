export const VALID_CLIS = ["codex", "claude", "gemini", "cursor"] as const;

export type CliName = (typeof VALID_CLIS)[number];

export type DebateMode = "multi-cli" | "single-cli";

export type StreamChunkHandler = (chunk: string) => void;

export type CliModels = Record<CliName, string>;

export const DEFAULT_MODELS: CliModels = {
  claude: "claude-opus-4-6",
  codex: "gpt-5.5",
  gemini: "gemini-3-flash-preview",
  cursor: "auto"
};

export interface ActorConfig {
  id?: string;
  cli: CliName;
  role: string;
  model?: string;
  behavior?: string;
}

export interface ResolvedActor {
  id: string;
  cli: CliName;
  role: string;
  roleName: string;
  model: string;
  behavior: string;
  label: string;
}

export interface CliOptions {
  request: string;
  actors: ResolvedActor[];
  leader: CliName;
  leaderModel: string;
  limit: number;
  humanInTheLoop: boolean;
  models: CliModels;
  contextRefs: string[];
  customRoles?: Record<string, string>;
}

export interface DebateConfig {
  debateMode?: DebateMode;
  actors: ActorConfig[];
  leader: CliName;
  leaderModel?: string;
  limit: number;
  humanInTheLoop: boolean;
  models: Partial<CliModels>;
  customRoles?: Record<string, string>;
  /** @deprecated legacy field, migrated to actors on load */
  clis?: CliName[];
}

export interface LoadedContext {
  ref: string;
  path: string;
  content: string;
}

export interface LeaderDecision {
  needsClarification: boolean;
  clarificationQuestion?: string;
  nextQuestion?: string;
  roundSummary?: string;
  shouldStop: boolean;
  finalSynthesis?: string;
  modelObservations?: string;
}

export interface AdapterRunResult {
  cli: CliName;
  output: string;
  exitCode: number;
}

export interface AgentAdapter {
  runActor(prompt: string, onChunk?: StreamChunkHandler): Promise<AdapterRunResult>;
  runLeader(prompt: string, expectedDecision: string, onChunk?: StreamChunkHandler): Promise<AdapterRunResult>;
}

export interface DebateEngineResult {
  finalSynthesis: string;
  modelObservations: string;
  reportPath: string;
  logPath: string;
  rounds: number;
}

export function uniqueClis(actors: Pick<ResolvedActor, "cli">[]): CliName[] {
  return [...new Set(actors.map((actor) => actor.cli))];
}
