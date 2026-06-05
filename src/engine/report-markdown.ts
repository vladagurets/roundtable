import { oneLine } from "../util/text.ts";
import type { ResolvedActor } from "../types.ts";

export interface ActorRoundResult {
  actor: ResolvedActor;
  ok: boolean;
  output: string;
}

export function firstPeerRoundQuestion(request: string, earlySynthesis?: string): string {
  if (earlySynthesis) {
    return [
      "The leader produced an early synthesis before any peer actor answered.",
      "Critique it, identify missing assumptions or risks, and improve the recommendation.",
      "",
      "Original request:",
      request,
      "",
      "Early synthesis:",
      earlySynthesis
    ].join("\n");
  }

  return [
    "Evaluate the original request as a neutral peer.",
    "Surface the strongest argument, biggest risks, missing context, and the most useful next step.",
    "",
    "Original request:",
    request
  ].join("\n");
}

export function compactRecentTranscript(round: number, question: string, runningContext: string): string[] {
  return [
    [
      `Rounds 1-${round} were compacted by the leader into Running Context.`,
      "Use Running Context as the authoritative debate memory instead of requesting or replaying old raw transcript.",
      "",
      `Most recent leader question (round ${round}):`,
      question,
      "",
      "Most recent compact context snapshot:",
      runningContext.trim() || "No running context yet."
    ].join("\n")
  ];
}

export function buildRoundRecord(round: number, question: string, actorResults: ActorRoundResult[], runningContext: string): string {
  return [
    `### Round ${round} Compact Record`,
    "",
    "**Leader question:**",
    question.trim(),
    "",
    "**Participant outcomes:**",
    ...actorResults.map(formatActorOutcome),
    "",
    "**Leader-compacted debate memory:**",
    runningContext.trim() || "No compact context was produced."
  ].join("\n");
}

export function fallbackRoundSummary(actorResults: ActorRoundResult[]): string {
  return [
    "The leader did not provide a round summary, so the engine preserved only compact participant outcomes.",
    "",
    "Participant outcomes:",
    ...actorResults.map(formatActorOutcome)
  ].join("\n");
}

export function failureModelObservations(actorResults: ActorRoundResult[]): string {
  return [
    "No model performed well enough to continue the debate because every actor failed in the current round.",
    "Failures:",
    ...actorResults.map((result) => `- ${result.actor.label}: ${oneLine(result.output, 140) || "No failure details"}`)
  ].join("\n");
}

function formatActorOutcome(result: ActorRoundResult): string {
  if (result.ok) {
    return `- ${result.actor.label}: answered (${result.output.length} chars before compaction)`;
  }

  return `- ${result.actor.label}: failed - ${oneLine(result.output, 140) || "No failure details"}`;
}
