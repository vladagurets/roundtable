import type { LoadedContext, ResolvedActor } from "./types.ts";

export interface LeaderPromptInput {
  originalRequest: string;
  contexts: LoadedContext[];
  runningContext: string;
  recentTranscript: string;
  limit: number;
  questionsUsed: number;
  humanInTheLoop: boolean;
  mode: "decision" | "summary" | "final";
  participants?: ResolvedActor[];
}

export interface ActorPromptInput {
  originalRequest: string;
  contexts: LoadedContext[];
  runningContext: string;
  recentTranscript: string;
  currentQuestion: string;
  roleName: string;
  roleBehavior: string;
}

export function buildLeaderPrompt(input: LeaderPromptInput): string {
  const roster = input.participants && input.participants.length > 0
    ? [
      "Participants:",
      input.participants.map((actor) => `${actor.role} (${actor.cli})`).join(", "),
      "Tailor questions to elicit role-appropriate responses.",
      ""
    ].join("\n")
    : "";

  return [
    "You are the neutral leader of a peer debate between local AI CLI agents.",
    "Drive the discussion toward a useful final synthesis for the user's request.",
    "You own dynamic context compaction: keep Running Context cumulative, compact, source-grounded, and small enough to replace old raw transcript.",
    "",
    roster,
    "Return only a JSON object with these keys:",
    "{",
    '  "needsClarification": boolean,',
    '  "clarificationQuestion": string | null,',
    '  "nextQuestion": string | null,',
    '  "roundSummary": string | null,',
    '  "shouldStop": boolean,',
    '  "finalSynthesis": string | null,',
    '  "modelObservations": string | null',
    "}",
    "",
    `Mode: ${input.mode}`,
    `Human in the loop: ${input.humanInTheLoop}`,
    `Leader debate questions used: ${input.questionsUsed} of ${input.limit}`,
    "",
    "Original request:",
    input.originalRequest,
    "",
    renderContexts(input.contexts),
    "",
    "Running context:",
    input.runningContext || "No running context yet.",
    "",
    input.mode === "summary" ? "Latest un-compacted round transcript:" : "Recent compact transcript:",
    input.recentTranscript || "No debate rounds yet.",
    "",
    modeInstruction(input.mode)
  ].join("\n");
}

export function buildActorPrompt(input: ActorPromptInput): string {
  return [
    input.roleBehavior,
    "",
    "Start your response with a short 'Reasoning summary' section: 2-4 bullets explaining your main considerations.",
    "Do not reveal private chain-of-thought; provide a concise rationale summary only.",
    "Refer to other participants by their role names when engaging with their arguments.",
    "",
    "Original request:",
    input.originalRequest,
    "",
    renderContexts(input.contexts),
    "",
    "Running context:",
    input.runningContext || "No running context yet.",
    "",
    "Recent transcript:",
    input.recentTranscript || "No debate rounds yet.",
    "",
    "Leader's current question:",
    input.currentQuestion
  ].join("\n");
}

function modeInstruction(mode: LeaderPromptInput["mode"]): string {
  if (mode === "summary") {
    return [
      "Summarize the latest round into a concise cumulative Running Context update.",
      "The roundSummary must replace the previous Running Context, so preserve only durable conclusions, participant behaviors, disagreements, open questions, evidence, failures, and next-step implications.",
      "Do not copy full actor answers, prompts, logs, stack traces, or repeated source material; mention failures briefly with their cause.",
      "Set shouldStop false unless the debate is clearly complete."
    ].join(" ");
  }

  if (mode === "final") {
    return [
      "Produce the final synthesis now. Set shouldStop true and finalSynthesis to the final answer.",
      "Also set modelObservations to a short, plain-language note on model performance for this topic: who performed well, who performed poorly, and the main reasons.",
      "Keep modelObservations concise, specific, and understandable. Avoid raw logs and avoid repeating the final synthesis."
    ].join(" ");
  }

  return "Decide whether to ask one clarification, issue the next debate question, or stop with a final synthesis. If stopping with finalSynthesis, also include modelObservations with a short note on who performed well or poorly and why. If there are no debate rounds yet, do not stop: issue a nextQuestion for the actors. If the question limit is reached, stop.";
}

function renderContexts(contexts: LoadedContext[]): string {
  if (contexts.length === 0) {
    return "Loaded context files:\nNone.";
  }

  return [
    "Loaded context files:",
    ...contexts.map((context) => [
      `--- @${context.ref} ---`,
      context.content.trim(),
      `--- end @${context.ref} ---`
    ].join("\n"))
  ].join("\n");
}
