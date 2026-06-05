import type { Writable } from "node:stream";
import { createAdapter } from "../adapters.ts";
import { DEFAULT_MODELS, type AgentAdapter, type CliModels, type CliName, type DebateEngineResult, type LeaderDecision, type LoadedContext, type ResolvedActor } from "../types.ts";
import { buildActorPrompt, buildLeaderPrompt } from "../prompts.ts";
import { DebateSession } from "../session.ts";
import { DebateTui, leaderId } from "../tui.ts";
import { parseLeaderDecision } from "./leader-decision.ts";
import { finalReportFromDecision, type DebateFinalReport } from "./finalize.ts";
import {
  buildRoundRecord,
  compactRecentTranscript,
  failureModelObservations,
  fallbackRoundSummary,
  firstPeerRoundQuestion,
  type ActorRoundResult
} from "./report-markdown.ts";

export interface DebateEngineOptions {
  rootDir: string;
  request: string;
  actors: ResolvedActor[];
  limit: number;
  leader: CliName;
  humanInTheLoop: boolean;
  models?: CliModels;
  contexts: LoadedContext[];
  leaderAdapter?: AgentAdapter;
  createActorAdapter?: (actor: ResolvedActor) => AgentAdapter;
  /** Callback when the leader asks the user a clarification question. */
  askHuman?: (question: string) => Promise<string>;
  output?: Writable;
  now?: Date;
}

const HEARTBEAT_MS = 10_000;

export class DebateEngine {
  private readonly options: DebateEngineOptions;
  private readonly tui: DebateTui;

  constructor(options: DebateEngineOptions) {
    this.options = options;
    this.tui = new DebateTui(options.output);
  }

  async run(): Promise<DebateEngineResult> {
    const session = await DebateSession.create(this.options.rootDir, this.options.request, this.options.contexts, {
      now: this.options.now
    });
    this.tui.setSession({
      reportPath: session.reportPath,
      logPath: session.logPath,
      limit: this.options.limit,
      humanInTheLoop: this.options.humanInTheLoop,
      leader: {
        cli: this.options.leader,
        model: this.modelFor(this.options.leader)
      },
      actors: this.options.actors.map((actor) => ({
        id: actor.id,
        cli: actor.cli,
        model: actor.model,
        role: actor.role,
        roleName: actor.roleName,
        label: actor.label
      }))
    });
    let recentTranscript: string[] = [];
    let questionsUsed = 0;
    let round = 0;
    let clarificationAsked = false;

    try {
      while (true) {
        const decision = await this.askLeader(session, recentTranscript, questionsUsed, "decision");
        this.writeLeaderDecision(decision, "decision");

        if (decision.needsClarification && decision.clarificationQuestion && !clarificationAsked) {
          clarificationAsked = true;
          this.tui.status("Leader requested clarification from you.");
          const answer = this.options.humanInTheLoop
            ? await this.askHuman(decision.clarificationQuestion)
            : "No human clarification was requested because --human-in-the-loop=false. Continue with explicit assumptions.";
          await session.appendClarification(decision.clarificationQuestion, answer);
          recentTranscript.push(`Clarification question: ${decision.clarificationQuestion}\nAnswer: ${answer}`);
          this.tui.status("Clarification recorded. Resuming debate.");
          continue;
        }

        const mustRunFirstPeerRound = round === 0 && this.options.actors.length > 0 && questionsUsed < this.options.limit;
        const leaderTriedToFinish = decision.shouldStop || !decision.nextQuestion;
        if (leaderTriedToFinish && mustRunFirstPeerRound) {
          this.tui.status("Leader tried to finish before any actor answered. Forcing first peer round.");
          decision.shouldStop = false;
          decision.nextQuestion = firstPeerRoundQuestion(this.options.request, decision.finalSynthesis);
          decision.finalSynthesis = undefined;
        }

        if (decision.shouldStop || !decision.nextQuestion || questionsUsed >= this.options.limit) {
          return await this.finishRun(session, recentTranscript, questionsUsed, round, decision);
        }

        questionsUsed += 1;
        round += 1;
        const question = decision.nextQuestion;
        await session.appendLeaderQuestion(round, question);
        const roundTranscript = [`Round ${round} leader question:\n${question}`];
        this.tui.setQuestion(round, this.options.limit, question);
        this.tui.status("Participants are answering.");

        const actorResults = await this.runActorRound(session, round, question, recentTranscript);

        const successes = actorResults.filter((result) => result.ok);
        if (successes.length < 1) {
          return await this.finishAfterTotalFailure(session, round, question, actorResults, questionsUsed);
        }

        for (const result of actorResults) {
          if (result.ok) {
            roundTranscript.push(`Round ${round} ${result.actor.label} answer:\n${result.output}`);
          } else {
            roundTranscript.push(`Round ${round} ${result.actor.label} failure:\n${result.output}`);
          }
        }

        const summaryDecision = await this.askLeader(session, [...recentTranscript, ...roundTranscript], questionsUsed, "summary");
        this.writeLeaderDecision(summaryDecision, "summary");
        const runningContext = summaryDecision.roundSummary || summaryDecision.finalSynthesis || fallbackRoundSummary(actorResults);
        await session.updateRunningContext(runningContext);
        await session.appendRoundRecord(round, question, actorResults, runningContext);
        recentTranscript = compactRecentTranscript(round, question, runningContext);
        this.tui.status("Running context compacted.");

        if (questionsUsed >= this.options.limit) {
          this.tui.setFinalizing(questionsUsed, this.options.limit);
          this.tui.status("Question limit reached. Asking leader for final synthesis.");
          const finalReport = await this.finalize(session, recentTranscript, questionsUsed);
          await session.appendFinalReport(finalReport.finalSynthesis, finalReport.modelObservations);
          this.tui.status("Final synthesis saved.");
          this.tui.close();
          return this.buildResult(session, finalReport, round);
        }
      }
    } catch (error) {
      this.tui.close();
      throw error;
    }
  }

  private async finishRun(
    session: DebateSession,
    recentTranscript: string[],
    questionsUsed: number,
    round: number,
    decision: LeaderDecision
  ): Promise<DebateEngineResult> {
    this.tui.setFinalizing(questionsUsed, this.options.limit);
    this.tui.status("Leader decided the debate is ready to finish.");
    const finalReport = decision.finalSynthesis
      ? finalReportFromDecision(decision)
      : await this.finalize(session, recentTranscript, questionsUsed);
    await session.appendFinalReport(finalReport.finalSynthesis, finalReport.modelObservations);
    this.tui.status("Final synthesis saved.");
    this.tui.close();
    return this.buildResult(session, finalReport, round);
  }

  private async finishAfterTotalFailure(
    session: DebateSession,
    round: number,
    question: string,
    actorResults: ActorRoundResult[],
    questionsUsed: number
  ): Promise<DebateEngineResult> {
    this.tui.setFinalizing(questionsUsed, this.options.limit);
    await session.appendRoundRecord(round, question, actorResults, "No actor answered successfully, so the debate stopped before leader compaction.");
    const finalSynthesis = [
      "The debate could not continue because every actor failed in the current round.",
      "Compact failure details are saved in the debate report."
    ].join("\n\n");
    const modelObservations = failureModelObservations(actorResults);
    await session.appendFinalReport(finalSynthesis, modelObservations);
    this.tui.status("Every actor failed. Failure synthesis saved.");
    this.tui.close();
    return this.buildResult(session, { finalSynthesis, modelObservations }, round);
  }

  private buildResult(session: DebateSession, finalReport: DebateFinalReport, round: number): DebateEngineResult {
    return {
      finalSynthesis: finalReport.finalSynthesis,
      modelObservations: finalReport.modelObservations,
      reportPath: session.reportPath,
      logPath: session.logPath,
      rounds: round
    };
  }

  private async runActorRound(
    session: DebateSession,
    round: number,
    question: string,
    recentTranscript: string[]
  ): Promise<ActorRoundResult[]> {
    return Promise.all(this.options.actors.map(async (actor) => {
      const prompt = buildActorPrompt({
        originalRequest: this.options.request,
        contexts: this.options.contexts,
        runningContext: await session.runningContext(),
        recentTranscript: recentTranscript.slice(-6).join("\n\n"),
        currentQuestion: question,
        roleName: actor.roleName,
        roleBehavior: actor.behavior
      });
      const rawChunks: string[] = [];
      await session.appendLog({
        type: "actor_prompt",
        round,
        actorId: actor.id,
        cli: actor.cli,
        role: actor.role,
        roleName: actor.roleName,
        model: actor.model,
        prompt
      });

      try {
        const adapter = this.adapterFor(actor);
        const result = await this.withProgress({
          id: actor.id,
          kind: "actor",
          cli: actor.cli,
          model: actor.model,
          label: actor.label,
          status: "answering"
        }, () => adapter.runActor(prompt, (chunk) => {
          rawChunks.push(chunk);
          this.streamActor(actor.id)(chunk);
        }));
        await session.appendLog({
          type: "actor_result",
          round,
          actorId: actor.id,
          cli: actor.cli,
          role: actor.role,
          roleName: actor.roleName,
          model: actor.model,
          exitCode: result.exitCode,
          rawOutput: rawChunks.join(""),
          normalizedOutput: result.output
        });
        if (result.exitCode !== 0) {
          throw new Error(result.output || `${actor.label} exited with code ${result.exitCode}`);
        }

        return { actor, ok: true, output: result.output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await session.appendLog({
          type: "actor_failure",
          round,
          actorId: actor.id,
          cli: actor.cli,
          role: actor.role,
          roleName: actor.roleName,
          model: actor.model,
          rawOutput: rawChunks.join(""),
          error: message
        });
        return { actor, ok: false, output: message };
      }
    }));
  }

  private async askLeader(session: DebateSession, recentTranscript: string[], questionsUsed: number, mode: "decision" | "summary" | "final"): Promise<LeaderDecision> {
    const prompt = buildLeaderPrompt({
      originalRequest: this.options.request,
      contexts: this.options.contexts,
      runningContext: await session.runningContext(),
      recentTranscript: recentTranscript.slice(-8).join("\n\n"),
      limit: this.options.limit,
      questionsUsed,
      humanInTheLoop: this.options.humanInTheLoop,
      mode,
      participants: mode === "final" ? undefined : this.options.actors
    });
    const rawChunks: string[] = [];
    await session.appendLog({
      type: "leader_prompt",
      mode,
      cli: this.options.leader,
      model: this.modelFor(this.options.leader),
      questionsUsed,
      prompt
    });
    this.tui.setLeaderPending(mode);
    const leaderAdapter = this.options.leaderAdapter ?? createAdapter(this.options.leader, this.modelFor(this.options.leader));
    const result = await this.withProgress({
      id: leaderId(mode),
      kind: "leader",
      cli: this.options.leader,
      model: this.modelFor(this.options.leader),
      label: `${this.options.leader} ${mode}`,
      status: mode === "summary" ? "summarizing" : "asking"
    }, () => leaderAdapter.runLeader(prompt, mode, (chunk) => {
      rawChunks.push(chunk);
    }));
    await session.appendLog({
      type: "leader_result",
      mode,
      cli: this.options.leader,
      model: this.modelFor(this.options.leader),
      exitCode: result.exitCode,
      rawOutput: rawChunks.join(""),
      normalizedOutput: result.output
    });

    if (result.exitCode !== 0) {
      await session.appendLog({
        type: "leader_failure",
        mode,
        cli: this.options.leader,
        model: this.modelFor(this.options.leader),
        rawOutput: rawChunks.join(""),
        error: result.output
      });
      throw new Error(`Leader ${this.options.leader} failed: ${result.output}`);
    }

    return parseLeaderDecision(result.output);
  }

  private async finalize(session: DebateSession, recentTranscript: string[], questionsUsed: number): Promise<DebateFinalReport> {
    const decision = await this.askLeader(session, recentTranscript, questionsUsed, "final");
    return finalReportFromDecision(decision);
  }

  private async askHuman(question: string): Promise<string> {
    if (this.options.askHuman) {
      return this.options.askHuman(question);
    }

    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });

    try {
      return await rl.question(`[roundtable] The leader needs your input:\n${question}\n[roundtable] Your answer: `);
    } finally {
      rl.close();
    }
  }

  private streamActor(actorId: string): (chunk: string) => void {
    return (chunk: string) => {
      if (chunk.length === 0) {
        return;
      }

      this.tui.updateParticipant(actorId, "answering");
    };
  }

  private adapterFor(actor: ResolvedActor): AgentAdapter {
    if (this.options.createActorAdapter) {
      return this.options.createActorAdapter(actor);
    }

    return createAdapter(actor.cli, actor.model);
  }

  private async withProgress<T>(progress: {
    id: string;
    kind: "leader" | "actor";
    cli: CliName;
    model: string;
    label: string;
    status: "asking" | "answering" | "summarizing";
  }, action: () => Promise<T>): Promise<T> {
    this.tui.startParticipant(progress.id, progress.kind, progress.cli, progress.model, progress.label, progress.status);
    const timer = setInterval(() => {
      this.tui.heartbeat(progress.id);
    }, HEARTBEAT_MS);

    try {
      const result = await action();
      clearInterval(timer);
      this.tui.finishParticipant(progress.id);
      return result;
    } catch (error) {
      clearInterval(timer);
      this.tui.failParticipant(progress.id);
      throw error;
    }
  }

  private writeLeaderDecision(decision: LeaderDecision, mode: "decision" | "summary" | "final"): void {
    if (decision.needsClarification && decision.clarificationQuestion) {
      this.tui.status(`Leader ${mode} requested clarification.`);
      return;
    }

    if (decision.nextQuestion) {
      this.tui.status(`Leader ${mode} chose the next question.`);
      return;
    }

    if (decision.roundSummary) {
      this.tui.status(`Leader ${mode} updated the compact summary.`);
      return;
    }

    if (decision.finalSynthesis) {
      this.tui.status(`Leader ${mode} produced final synthesis.`);
      return;
    }

    if (decision.shouldStop) {
      this.tui.status(`Leader ${mode} chose to stop.`);
    }
  }

  private modelFor(cli: CliName): string {
    return (this.options.models ?? DEFAULT_MODELS)[cli];
  }
}
