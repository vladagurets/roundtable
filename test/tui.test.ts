import test from "node:test";
import assert from "node:assert/strict";
import { DebateTui, leaderId } from "../src/tui.ts";
import { stripAnsi, TtyMemoryWritable } from "./helpers/mock-tty.ts";

test("renders an interactive dashboard with leader and participant rows", () => {
  const output = new TtyMemoryWritable();
  const tui = new DebateTui(output);

  tui.setSession({
    reportPath: "/tmp/debates/example.md",
    logPath: "/tmp/debates/example.log.jsonl",
    limit: 3,
    humanInTheLoop: true,
    leader: { cli: "codex", model: "gpt-5.5" },
    actors: [
      { id: "critic-claude", cli: "claude", model: "claude-opus-4.6", role: "critic", roleName: "Critic", label: "critic · claude" },
      { id: "verifier-gemini", cli: "gemini", model: "gemini-2.5-flash", role: "verifier", roleName: "Verifier", label: "verifier · gemini" }
    ]
  });
  tui.startParticipant(leaderId("decision"), "leader", "codex", "gpt-5.5", "codex decision", "asking");
  tui.setQuestion(1, 3, "What is the central risk?");
  tui.startParticipant("critic-claude", "actor", "claude", "claude-opus-4.6", "critic · claude", "answering");
  tui.streamActor("critic-claude", "Reasoning summary: focus on trust and network effects.");
  tui.finishParticipant("critic-claude");
  tui.setFinalizing(2, 3);
  tui.close();

  assert.match(output.text, /\u001b\[H\u001b\[J/);
  assert.match(stripAnsi(output.text), /██████╗.*██████╗/);
  assert.match(output.text, /Phase/);
  assert.match(output.text, /Leader: codex decision/);
  assert.match(output.text, /Participant: critic · claude/);
  assert.match(output.text, /Report/);
  assert.match(output.text, /Logs/);
  assert.match(output.text, /limit=3/);
  assert.match(output.text, /What is the central risk\?/);
  assert.match(output.text, /Finalizing.*Round 3\/3/);
  assert.doesNotMatch(output.text, /Reasoning summary/);
});

test("participant rows autopad who, status, and elapsed columns", () => {
  const output = new TtyMemoryWritable();
  const tui = new DebateTui(output);

  tui.setSession({
    reportPath: "/tmp/debates/example.md",
    logPath: "/tmp/debates/example.log.jsonl",
    limit: 3,
    humanInTheLoop: false,
    leader: { cli: "gemini", model: "gemini-3-flash-preview" },
    actors: [
      { id: "peer-gemini", cli: "gemini", model: "gemini-3-flash-preview", role: "peer", roleName: "Peer", label: "peer · gemini" },
      { id: "critic-gemini", cli: "gemini", model: "gemini-3-flash-preview", role: "critic", roleName: "Critic", label: "critic · gemini" },
      { id: "verifier-gemini", cli: "gemini", model: "gemini-3-flash-preview", role: "verifier", roleName: "Verifier", label: "verifier · gemini" }
    ]
  });
  tui.startParticipant(leaderId("decision"), "leader", "gemini", "gemini-3-flash-preview", "gemini decision", "finished");
  tui.startParticipant("peer-gemini", "actor", "gemini", "gemini-3-flash-preview", "peer · gemini", "answering");
  tui.startParticipant("critic-gemini", "actor", "gemini", "gemini-3-flash-preview", "critic · gemini", "finished");
  tui.startParticipant("verifier-gemini", "actor", "gemini", "gemini-3-flash-preview", "verifier · gemini", "answering");
  tui.close();

  const lastFrame = output.text.split("\u001b[H\u001b[J").at(-1) ?? output.text;
  const participantLines = lastFrame
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))
    .filter((line) => /^│ (?:Leader|Participant):/.test(line));

  assert.equal(participantLines.length, 4);

  const iconColumns = participantLines.map((line) => {
    const match = line.match(/[◐◓◑◒✓✕•]/);
    return match ? line.indexOf(match[0]) : -1;
  });
  const statusColumns = participantLines.map((line) => {
    const match = line.match(/\s(asking|answering|finished|failed|summarizing|idle)\s/);
    return match ? line.indexOf(match[1]) : -1;
  });
  const modelColumns = participantLines.map((line) => line.lastIndexOf("gemini-3-flash-preview"));

  assert.ok(iconColumns.every((column) => column === iconColumns[0]), `icon columns misaligned: ${iconColumns.join(", ")}`);
  assert.ok(statusColumns.every((column) => column === statusColumns[0]), `status columns misaligned: ${statusColumns.join(", ")}`);
  assert.ok(modelColumns.every((column) => column === modelColumns[0]), `model columns misaligned: ${modelColumns.join(", ")}`);
});

test("events clarify actors with leader/participant prefix and dedupe heartbeats", () => {
  const output = new TtyMemoryWritable();
  const tui = new DebateTui(output);

  tui.setSession({
    reportPath: "/tmp/debates/example.md",
    logPath: "/tmp/debates/example.log.jsonl",
    limit: 3,
    humanInTheLoop: false,
    leader: { cli: "gemini", model: "gemini-3-flash-preview" },
    actors: [
      { id: "verifier-gemini", cli: "gemini", model: "gemini-3-flash-preview", role: "verifier", roleName: "Verifier", label: "verifier · gemini" }
    ]
  });
  tui.startParticipant("verifier-gemini", "actor", "gemini", "gemini-3-flash-preview", "verifier · gemini", "answering");
  tui.heartbeat("verifier-gemini");
  tui.heartbeat("verifier-gemini");
  tui.heartbeat("verifier-gemini");
  tui.close();

  const lastFrame = output.text.split("\u001b[H\u001b[J").at(-1) ?? output.text;
  const eventLines = lastFrame
    .split("\n")
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))
    .filter((line) => line.includes("still running after") || line.includes("started."));

  const heartbeatLines = eventLines.filter((line) => line.includes("still running after"));
  assert.equal(heartbeatLines.length, 1);
  assert.match(heartbeatLines[0], /Participant: verifier · gemini \(answering\) still running after/);
  assert.match(eventLines.find((line) => line.includes("started.")) ?? "", /Participant: verifier · gemini started\./);
});
