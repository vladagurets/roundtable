import type { LeaderDecision } from "../types.ts";

export interface DebateFinalReport {
  finalSynthesis: string;
  modelObservations: string;
}

export function finalReportFromDecision(decision: LeaderDecision): DebateFinalReport {
  return {
    finalSynthesis: decision.finalSynthesis || decision.roundSummary || "No final synthesis was produced.",
    modelObservations: decision.modelObservations || [
      "The leader did not provide model performance observations.",
      "Review the participant outcomes and detailed logs for a manual comparison."
    ].join(" ")
  };
}
