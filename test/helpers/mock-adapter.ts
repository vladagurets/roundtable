import type { AdapterRunResult, AgentAdapter, CliName } from "../../src/types.ts";

export class MockAdapter implements AgentAdapter {
  actorCalls = 0;
  leaderCalls = 0;
  actorPrompts: string[] = [];
  leaderPrompts: string[] = [];
  private readonly cli: CliName;
  private readonly decisions: Array<Record<string, unknown>>;
  private readonly actorOutput: string;
  private readonly actorExitCode: number;

  constructor(cli: CliName, decisions: Array<Record<string, unknown>>, actorOutput: string, actorExitCode = 0) {
    this.cli = cli;
    this.decisions = decisions;
    this.actorOutput = actorOutput;
    this.actorExitCode = actorExitCode;
  }

  async runActor(prompt: string, onChunk?: (chunk: string) => void): Promise<AdapterRunResult> {
    this.actorCalls += 1;
    this.actorPrompts.push(prompt);
    onChunk?.(this.actorOutput);
    return {
      cli: this.cli,
      output: this.actorOutput,
      exitCode: this.actorExitCode
    };
  }

  async runLeader(prompt: string, _expectedDecision?: string, onChunk?: (chunk: string) => void): Promise<AdapterRunResult> {
    this.leaderCalls += 1;
    this.leaderPrompts.push(prompt);
    const decision = this.decisions.shift();
    if (!decision) {
      throw new Error(`${this.cli} has no queued decision`);
    }

    const output = JSON.stringify(decision);
    onChunk?.(output);
    return {
      cli: this.cli,
      output,
      exitCode: 0
    };
  }
}
