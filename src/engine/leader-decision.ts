// Take the last JSON object in leader CLI output that matches debate decision keys.
import type { LeaderDecision } from "../types.ts";

export function parseLeaderDecision(raw: string): LeaderDecision {
  const parsed = extractLeaderDecisionObject(raw);

  return {
    needsClarification: Boolean(parsed.needsClarification),
    clarificationQuestion: parsed.clarificationQuestion ?? undefined,
    nextQuestion: parsed.nextQuestion ?? undefined,
    roundSummary: parsed.roundSummary ?? undefined,
    shouldStop: Boolean(parsed.shouldStop),
    finalSynthesis: parsed.finalSynthesis ?? undefined,
    modelObservations: parsed.modelObservations ?? undefined
  };
}

function extractLeaderDecisionObject(raw: string): Partial<LeaderDecision> {
  const candidates = extractJsonObjectCandidates(raw);
  const decisions: Array<Partial<LeaderDecision>> = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<LeaderDecision>;
      if (isLeaderDecisionLike(parsed)) {
        decisions.push(parsed);
      }
    } catch {
      // Keep scanning. CLI output can include prompts, diagnostics, or JSONL events.
    }
  }

  const decision = decisions.at(-1);
  if (!decision) {
    const preview = raw.replace(/\s+/g, " ").trim();
    const snippet = preview.length <= 200 ? preview : `${preview.slice(0, 197)}...`;
    throw new Error(`Leader response did not contain a valid decision JSON object. Preview: ${snippet} (see session log for full output)`);
  }

  return decision;
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          candidates.push(raw.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}

function isLeaderDecisionLike(value: unknown): value is Partial<LeaderDecision> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return [
    "needsClarification",
    "clarificationQuestion",
    "nextQuestion",
    "roundSummary",
    "shouldStop",
    "finalSynthesis",
    "modelObservations"
  ].some((key) => key in record);
}
