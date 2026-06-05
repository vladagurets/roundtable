export const BUILTIN_ROLE_IDS = [
  "peer",
  "proposer",
  "critic",
  "verifier",
  "contrarian",
  "pragmatist"
] as const;

export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

export const CUSTOM_ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

interface BuiltinRole {
  id: BuiltinRoleId;
  name: string;
  behavior: string;
}

const BUILTIN_ROLES: Record<BuiltinRoleId, BuiltinRole> = {
  peer: {
    id: "peer",
    name: "Peer",
    behavior: [
      "You are a neutral peer in a multi-agent debate.",
      "Challenge assumptions, improve reasoning, and answer the leader's question directly.",
      "Do not claim authority over other agents. Be concise but substantive.",
      "When others have staked positions, engage with their strongest points, not strawmen."
    ].join("\n")
  },
  proposer: {
    id: "proposer",
    name: "Proposer",
    behavior: [
      "You are the Proposer. Your job is to commit to a clear, defensible position.",
      "State your claim upfront, then provide a reasoning chain: premises → inference → conclusion.",
      "Acknowledge genuine uncertainty, but do not hide behind vague hedging — take a stand the group can attack.",
      "If a position already exists in Running Context, refine or defend it rather than starting from scratch."
    ].join("\n")
  },
  critic: {
    id: "critic",
    name: "Critic",
    behavior: [
      "You are the Critic. Your job is to break the strongest argument on the table.",
      "Find logical gaps, unsupported assumptions, missing edge cases, and counterexamples.",
      "You must disagree constructively even when the prevailing answer looks correct — search for what could be wrong.",
      "Do not introduce new claims without flagging them as proposals, not facts."
    ].join("\n")
  },
  verifier: {
    id: "verifier",
    name: "Verifier",
    behavior: [
      "You are the Verifier. You do not argue for a side — you audit claims.",
      "Extract specific factual assertions, numbers, citations, and causal claims from recent answers.",
      "For each: mark Verified / Unverified / Likely wrong / Cannot assess from context.",
      "Flag probable hallucinations and unsupported assertions explicitly. Ignore rhetorical framing."
    ].join("\n")
  },
  contrarian: {
    id: "contrarian",
    name: "Contrarian",
    behavior: [
      "You are the Contrarian. Argue the strongest version of the least popular or most dismissed position.",
      "Do not pick a weak strawman — steelman the minority view until it is taken seriously.",
      "Explain what the emerging consensus might be overlooking and what would change minds.",
      "You are not required to believe the contrarian view; you must make it as compelling as possible."
    ].join("\n")
  },
  pragmatist: {
    id: "pragmatist",
    name: "Pragmatist",
    behavior: [
      "You are the Pragmatist. Translate abstract debate into what would actually work.",
      "Focus on feasibility, implementation cost, failure modes in production, and tradeoffs of action vs inaction.",
      "Ask: who does what, by when, with what resources, and what breaks first?",
      "Prefer concrete next steps over theoretical completeness."
    ].join("\n")
  }
};

export function isBuiltinRoleId(role: string): role is BuiltinRoleId {
  return (BUILTIN_ROLE_IDS as readonly string[]).includes(role);
}

export function roleDisplayName(role: string, customRoles?: Record<string, string>): string {
  if (isBuiltinRoleId(role)) {
    return BUILTIN_ROLES[role].name;
  }

  if (customRoles?.[role]) {
    return titleCaseRole(role);
  }

  return titleCaseRole(role);
}

export function validateCustomRoleName(name: string): void {
  if (!CUSTOM_ROLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid custom role name "${name}". Use lowercase letters, numbers, and hyphens (max 32 chars).`);
  }

  if (isBuiltinRoleId(name)) {
    throw new Error(`Custom role name "${name}" conflicts with a built-in role.`);
  }
}

export function resolveRoleBehavior(
  role: string,
  customRoles?: Record<string, string>,
  inlineBehavior?: string
): string {
  const behavior = inlineBehavior?.trim() || customRoles?.[role]?.trim();
  if (behavior) {
    return wrapCustomBehavior(behavior);
  }

  if (isBuiltinRoleId(role)) {
    return BUILTIN_ROLES[role].behavior;
  }

  throw new Error(`Unknown role "${role}". Use a built-in role (${BUILTIN_ROLE_IDS.join(", ")}) or define it in customRoles.`);
}

export function builtinRoleOptions(): Array<{ id: BuiltinRoleId; name: string }> {
  return BUILTIN_ROLE_IDS.map((id) => ({ id, name: BUILTIN_ROLES[id].name }));
}

function wrapCustomBehavior(behavior: string): string {
  return [
    "You are a debate participant with the following role and behavior:",
    behavior,
    "Answer the leader's current question according to this role. Do not break character."
  ].join("\n");
}

function titleCaseRole(role: string): string {
  return role.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
