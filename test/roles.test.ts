import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoleBehavior } from "../src/roles.ts";

test("built-in roles resolve behavior text", () => {
  assert.match(resolveRoleBehavior("proposer"), /You are the Proposer/);
  assert.match(resolveRoleBehavior("critic"), /You are the Critic/);
  assert.match(resolveRoleBehavior("verifier"), /You are the Verifier/);
});

test("custom roles resolve from registry or inline behavior", () => {
  const behavior = resolveRoleBehavior("security-auditor", {
    "security-auditor": "Focus on security risks."
  });

  assert.match(behavior, /Focus on security risks/);
  assert.match(resolveRoleBehavior("security-auditor", {}, "Inline behavior."), /Inline behavior/);
});

test("unknown role throws", () => {
  assert.throws(() => resolveRoleBehavior("unknown-role"), /Unknown role/);
});
