import { relative } from "node:path";
import type { Writable } from "node:stream";
import {
  BOLD,
  RESET,
  bottomLine,
  boxRow,
  colorizeBorders,
  padVisible,
  separator,
  topLine,
  visibleLength,
  wrapText
} from "./tui-frame.ts";
import { AltScreenSession } from "./terminal/core.ts";
import { colorCli } from "./terminal/colors.ts";
import { VALID_CLIS, type CliName } from "./types.ts";

type ParticipantKind = "leader" | "actor";
type ParticipantStatus = "idle" | "asking" | "answering" | "summarizing" | "finished" | "failed";

interface Participant {
  id: string;
  kind: ParticipantKind;
  cli: CliName;
  model: string;
  label: string;
  status: ParticipantStatus;
  startedAt?: number;
}

interface LeaderInfo {
  cli: CliName;
  model: string;
}

interface ActorInfo {
  id: string;
  cli: CliName;
  model: string;
  role: string;
  roleName: string;
  label: string;
}

interface SessionInfo {
  reportPath: string;
  logPath: string;
  limit: number;
  humanInTheLoop: boolean;
  leader: LeaderInfo;
  actors: ActorInfo[];
}

const SPINNER = ["◐", "◓", "◑", "◒"];
const LABEL_WIDTH = 10;

export class DebateTui {
  private readonly output?: Writable;
  private readonly screen?: AltScreenSession;
  private readonly interactive: boolean;
  private readonly participants = new Map<string, Participant>();
  private events: string[] = [];
  private renderTimer?: ReturnType<typeof setInterval>;
  private spinnerIndex = 0;
  private session?: SessionInfo;
  private currentRound = "";
  private currentQuestion = "";
  private phase = "Starting";
  private debateStartedAt?: number;

  constructor(output?: Writable) {
    this.output = output;
    this.interactive = Boolean(output && (output as Writable & { isTTY?: boolean }).isTTY);

    if (this.interactive && this.output) {
      this.screen = new AltScreenSession(this.output);
      this.screen.enter();
      this.screen.onResize(() => this.render());
    }
  }

  setSession(session: SessionInfo): void {
    this.debateStartedAt = Date.now();
    this.session = session;
    this.phase = "Session ready";
    this.status(`Report: ${relative(process.cwd(), session.reportPath)}`);
    this.status(`Logs: ${relative(process.cwd(), session.logPath)}`);
    this.status(`Limit: ${session.limit}`);
    this.status(`Leader: ${session.leader.cli} (${session.leader.model})`);
    this.status(`Participants: ${session.actors.map((actor) => `${actor.label} (${actor.model})`).join(", ")}`);
    this.startRenderLoop();
    this.render();
  }

  setQuestion(round: number, limit: number, question: string): void {
    this.currentRound = `Round ${round}/${limit}`;
    this.currentQuestion = `Round ${round}: ${question}`;
    this.phase = "Leader asked";
    this.status(`${this.currentRound}: leader question saved to report.`);
    this.render();
  }

  setFinalizing(questionsUsed: number, limit: number): void {
    const progress = limit > 0 ? Math.min(limit, questionsUsed + 1) : questionsUsed;
    this.currentRound = `Round ${progress}/${limit}`;
    this.phase = "Finalizing";
    this.status(`${this.currentRound}: final synthesis in progress.`);
    this.render();
  }

  status(message: string): void {
    if (!this.output) {
      return;
    }

    this.events.push(message);
    while (this.events.length > 8) {
      this.events.shift();
    }

    if (!this.interactive) {
      this.output.write(`[roundtable] ${message}\n`);
    }
  }

  startParticipant(id: string, kind: ParticipantKind, cli: CliName, model: string, label: string, status: ParticipantStatus): void {
    this.participants.set(id, {
      id,
      kind,
      cli,
      model,
      label,
      status,
      startedAt: Date.now()
    });
    this.status(`${participantWho({ kind, label })} started.`);
    this.startRenderLoop();
    this.render();
  }

  updateParticipant(id: string, status: ParticipantStatus): void {
    const participant = this.participants.get(id);
    if (!participant) {
      return;
    }

    participant.status = status;
    this.render();
  }

  finishParticipant(id: string): void {
    const participant = this.participants.get(id);
    if (!participant) {
      return;
    }

    participant.status = "finished";
    const elapsed = participant.startedAt ? formatDuration(Date.now() - participant.startedAt) : "0s";
    this.clearParticipantHeartbeat(participant);
    this.status(`${participantWho(participant)} finished in ${elapsed}.`);
    this.render();
  }

  failParticipant(id: string): void {
    const participant = this.participants.get(id);
    if (!participant) {
      return;
    }

    participant.status = "failed";
    const elapsed = participant.startedAt ? formatDuration(Date.now() - participant.startedAt) : "0s";
    this.clearParticipantHeartbeat(participant);
    this.status(`${participantWho(participant)} failed after ${elapsed}.`);
    this.render();
  }

  streamActor(actorId: string, _chunk: string): void {
    if (!this.output) {
      return;
    }

    this.updateParticipant(actorId, "answering");
  }

  heartbeat(id: string): void {
    const participant = this.participants.get(id);
    if (!participant || !participant.startedAt) {
      return;
    }

    const who = participantWho(participant);
    const elapsed = formatDuration(Date.now() - participant.startedAt);
    this.clearParticipantHeartbeat(participant);
    this.status(`${who} (${participant.status}) still running after ${elapsed}.`);
    this.render();
  }

  private clearParticipantHeartbeat(participant: Participant): void {
    const who = participantWho(participant);
    this.events = this.events.filter((event) => !isParticipantHeartbeat(who, event));
  }

  close(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }

    this.screen?.dispose();
  }

  private render(): void {
    if (!this.output || !this.interactive || !this.screen) {
      return;
    }

    const width = this.screen.width();
    const lines = this.frame(width);
    this.screen.clearScreen();

    for (const line of lines) {
      this.output.write(`${line}\n`);
    }
  }

  private frame(width: number): string[] {
    const innerWidth = Math.max(48, width - 4);
    const models = this.session
      ? VALID_CLIS.map((cli) => `${cli}=${modelFor(this.session!, cli)}`).join("  ")
      : "-";
    const rows = [
      topLine(innerWidth),
      ...fieldRows("Phase", `${this.phase}${this.currentRound ? ` · ${this.currentRound}` : ""}`, innerWidth),
      ...fieldRows("Elapsed", formatDuration(Date.now() - (this.debateStartedAt ?? Date.now())), innerWidth),
      ...fieldRows("Report", this.session?.reportPath ? relative(process.cwd(), this.session.reportPath) : "Creating session...", innerWidth),
      ...fieldRows("Logs", this.session?.logPath ? relative(process.cwd(), this.session.logPath) : "Creating session...", innerWidth),
      ...fieldRows("Params", this.session
        ? `limit=${this.session.limit}  human-in-the-loop=${this.session.humanInTheLoop}  leader=${this.session.leader.cli}  participants=${this.session.actors.map((actor) => actor.label).join(",")}`
        : "Loading parameters...", innerWidth),
      ...fieldRows("Models", models, innerWidth),
      ...fieldRows("Output", "Debate answers are written to the report, not stdout.", innerWidth),
      separator(innerWidth),
      ...fieldRows("Question", this.currentQuestion || "-", innerWidth),
      separator(innerWidth),
      ...this.participantRows(innerWidth),
      separator(innerWidth),
      ...fieldRows("Events", this.events.at(-1) ?? "-", innerWidth),
      ...this.events.slice(-5, -1).flatMap((event) => fieldRows("", event, innerWidth)),
      bottomLine(innerWidth)
    ];

    this.spinnerIndex = Math.floor(Date.now() / 250) % SPINNER.length;
    const phase = Date.now() / 30;
    return colorizeBorders(rows, phase);
  }

  private participantRows(innerWidth: number): string[] {
    const participants = [...this.participants.values()];
    if (participants.length === 0) {
      return fieldRows("-", "waiting", innerWidth);
    }

    const entries = participants.map((participant) => {
      const spinner = active(participant.status) ? SPINNER[this.spinnerIndex] : " ";
      return {
        who: participantWho(participant),
        icon: statusIcon(participant.status, spinner),
        status: participant.status,
        elapsed: participant.startedAt ? formatDuration(Date.now() - participant.startedAt) : "0s",
        model: participant.model
      };
    });

    const whoWidth = Math.max(...entries.map((entry) => visibleLength(entry.who)));
    const statusWidth = Math.max(...entries.map((entry) => visibleLength(entry.status)));
    const elapsedWidth = Math.max(...entries.map((entry) => visibleLength(entry.elapsed)));

    return entries.map((entry) => {
      const detail = [
        entry.icon,
        padVisible(entry.status, statusWidth),
        padVisible(entry.elapsed, elapsedWidth),
        entry.model
      ].join("  ");
      const content = `${padVisible(entry.who, whoWidth)}  ${detail}`;
      return boxRow(content, innerWidth);
    });
  }

  private startRenderLoop(): void {
    if (!this.interactive || this.renderTimer) {
      return;
    }

    this.renderTimer = setInterval(() => this.render(), 100);
  }
}

export function leaderId(mode: string): string {
  return `leader:${mode}`;
}

function participantWho(participant: Pick<Participant, "kind" | "label">): string {
  const role = participant.kind === "leader" ? "Leader" : "Participant";
  return `${role}: ${participant.label}`;
}

function isParticipantHeartbeat(who: string, event: string): boolean {
  return event.startsWith(`${who} `) && event.includes(" still running after ");
}

function active(status: ParticipantStatus): boolean {
  return status === "asking" || status === "answering" || status === "summarizing";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${String(remainder).padStart(2, "0")}s`;
}

function fieldRows(label: string, value: string, innerWidth: number): string[] {
  const valueWidth = Math.max(16, innerWidth - LABEL_WIDTH - 1);
  const lines = wrapText(value, valueWidth);

  return lines.map((line, index) => {
    const boldLabel = label ? `${BOLD}${label}${RESET}` : "";
    const left = index === 0 ? padVisible(boldLabel, LABEL_WIDTH) : " ".repeat(LABEL_WIDTH);
    return boxRow(`${left} ${line}`, innerWidth);
  });
}

function statusIcon(status: ParticipantStatus, spinner: string): string {
  if (active(status)) {
    return spinner;
  }

  if (status === "finished") {
    return "✓";
  }

  if (status === "failed") {
    return "✕";
  }

  return "•";
}

function modelFor(session: SessionInfo, cli: CliName): string {
  if (session.leader.cli === cli) {
    return session.leader.model;
  }

  const actors = session.actors.filter((actor) => actor.cli === cli);
  if (actors.length === 1) {
    return actors[0].model;
  }

  if (actors.length > 1) {
    return actors.map((actor) => `${actor.roleName}:${actor.model}`).join(" ");
  }

  return "-";
}

export { colorCli };
