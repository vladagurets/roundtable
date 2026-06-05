import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCommand, buildCodexCommand, buildCursorCommand, buildGeminiCommand, normalizeCliOutput, normalizeStreamJson } from "../src/adapters.ts";

test("builds Codex command with model and high reasoning", () => {
  const command = buildCodexCommand("Prompt", "gpt-5.5");

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args, [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="high"',
    "-"
  ]);
  assert.equal(command.stdin, "Prompt");
});

test("builds Claude command with model and thinking", () => {
  const command = buildClaudeCommand("Prompt", "claude-opus-4.6");

  assert.equal(command.command, "claude");
  assert.deepEqual(command.args, [
    "-p",
    "--permission-mode",
    "plan",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-opus-4.6",
    "--thinking",
    "enabled"
  ]);
  assert.equal(command.stdin, "Prompt");
});

test("builds Gemini command with model", () => {
  const command = buildGeminiCommand("Prompt", "gemini-2.5-flash");

  assert.equal(command.command, "gemini");
  assert.deepEqual(command.args, [
    "--prompt",
    "Prompt",
    "--approval-mode",
    "plan",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-2.5-flash"
  ]);
});

test("builds Cursor command with plan mode and stream-json", () => {
  const command = buildCursorCommand("Prompt", "auto");

  assert.equal(command.command, "agent");
  assert.deepEqual(command.args, [
    "-p",
    "--plan",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    "auto",
    "Prompt"
  ]);
  assert.equal(command.stdin, undefined);
});

test("normalizes Cursor stream-json assistant messages", () => {
  const output = normalizeStreamJson([
    '{"type":"system","subtype":"init","model":"auto"}',
    '{"type":"assistant","message":{"content":[{"text":"Useful answer"}]}}',
    '{"type":"result","status":"success","duration_ms":1234}'
  ].join("\n"));

  assert.equal(output, "Useful answer");
});

test("keeps successful plain text output intact", () => {
  const output = normalizeCliOutput("Line one\nLine two\nLine three", 0);

  assert.equal(output, "Line one\nLine two\nLine three");
});

test("normalizes mixed stream JSON without keeping echoed prompts or diagnostics", () => {
  const output = normalizeStreamJson([
    '{"type":"message","role":"user","content":"Original prompt that should not be transcript memory"}',
    '{"type":"message","role":"assistant","content":"Useful answer"}',
    "Ripgrep is not available. Falling back to GrepTool.",
    '{"type":"result","status":"success","stats":{"total_tokens":123}}'
  ].join("\n"));

  assert.equal(output, "Useful answer");
});

test("summarizes noisy CLI model errors", () => {
  const output = normalizeCliOutput([
    '{"type":"result","status":"error","error":{"message":"[API Error: An unknown error occurred.]"}}',
    "Ripgrep is not available. Falling back to GrepTool.",
    "Error when talking to Gemini API Full report available at: /tmp/report.json ModelNotFoundError: Requested entity was not found.",
    "    at classifyGoogleError (chunk.js:1:1)"
  ].join("\n"), 1);

  assert.equal(output, "Error when talking to Gemini API Full report available at: /tmp/report.json ModelNotFoundError: Requested entity was not found.");
});
