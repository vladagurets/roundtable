import path from "node:path";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { LoadedContext } from "./types.ts";
import { buildRoundRecord, type ActorRoundResult } from "./engine/report-markdown.ts";

const RUNNING_CONTEXT_HEADER = "## Running Context";
const TRANSCRIPT_HEADER = "## Transcript";

export interface DebateSessionOptions {
  now?: Date;
}

export class DebateSession {
  readonly reportPath: string;
  readonly logPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(reportPath: string, logPath: string) {
    this.reportPath = reportPath;
    this.logPath = logPath;
  }

  static async create(rootDir: string, request: string, contexts: LoadedContext[], options: DebateSessionOptions = {}): Promise<DebateSession> {
    const outputDir = path.resolve(rootDir);

    const date = formatDate(options.now ?? new Date());
    const topic = shortTopic(request);
    const reportPath = await uniqueReportPath(outputDir, `${date}-${topic}.md`);
    const logPath = logPathForReport(reportPath);
    const contextLines = contexts.length === 0
      ? "No context files loaded."
      : contexts.map((context) => `- @${context.ref}: ${context.path}`).join("\n");

    await writeFile(reportPath, [
      `# Debate: ${topic}`,
      "",
      `Created: ${(options.now ?? new Date()).toISOString()}`,
      "",
      "## Request",
      "",
      request,
      "",
      "## Context Files",
      "",
      contextLines,
      "",
      RUNNING_CONTEXT_HEADER,
      "",
      "No running context yet.",
      "",
      TRANSCRIPT_HEADER,
      ""
    ].join("\n"), "utf8");
    await writeFile(logPath, `${JSON.stringify({
      timestamp: (options.now ?? new Date()).toISOString(),
      type: "session_created",
      reportPath,
      logPath,
      request,
      contexts: contexts.map((context) => ({ ref: context.ref, path: context.path, chars: context.content.length }))
    })}\n`, "utf8");

    return new DebateSession(reportPath, logPath);
  }

  async appendLog(event: Record<string, unknown>): Promise<void> {
    await this.enqueueWrite(async () => {
      await appendLine(this.logPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event
      }));
    });
  }

  async appendMarkdown(markdown: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const current = await readFile(this.reportPath, "utf8");
      await writeFile(this.reportPath, `${current.trimEnd()}\n\n${markdown.trim()}\n`, "utf8");
    });
  }

  async appendLeaderQuestion(round: number, question: string): Promise<void> {
    await this.appendMarkdown(`### Round ${round} Leader Question\n\n${question}`);
  }

  async appendRoundRecord(round: number, question: string, actorResults: ActorRoundResult[], runningContext: string): Promise<void> {
    await this.appendMarkdown(buildRoundRecord(round, question, actorResults, runningContext));
  }

  async appendClarification(question: string, answer: string): Promise<void> {
    await this.appendMarkdown(`### Clarification\n\n**Question:** ${question}\n\n**Answer:** ${answer}`);
  }

  async appendFinalReport(finalSynthesis: string, modelObservations: string): Promise<void> {
    await this.appendMarkdown([
      "## Final Synthesis",
      "",
      finalSynthesis,
      "",
      "## Leader Model Observations",
      "",
      modelObservations
    ].join("\n"));
  }

  async updateRunningContext(summary: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const current = await readFile(this.reportPath, "utf8");
      const start = current.indexOf(RUNNING_CONTEXT_HEADER);
      const end = current.indexOf(TRANSCRIPT_HEADER);

      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Report is missing required Running Context or Transcript sections");
      }

      const before = current.slice(0, start + RUNNING_CONTEXT_HEADER.length);
      const after = current.slice(end);
      await writeFile(this.reportPath, `${before}\n\n${summary.trim() || "No running context yet."}\n\n${after}`, "utf8");
    });
  }

  async readMarkdown(): Promise<string> {
    return readFile(this.reportPath, "utf8");
  }

  async runningContext(): Promise<string> {
    const current = await readFile(this.reportPath, "utf8");
    const start = current.indexOf(RUNNING_CONTEXT_HEADER);
    const end = current.indexOf(TRANSCRIPT_HEADER);

    if (start === -1 || end === -1 || end <= start) {
      return "";
    }

    return current.slice(start + RUNNING_CONTEXT_HEADER.length, end).trim();
  }

  private async enqueueWrite(write: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}

function shortTopic(request: string): string {
  const words = request
    .replace(/@\S+/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.slice(0, 7) ?? ["roundtable"];

  const slug = words.join("-");
  return slug || "roundtable";
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function uniqueReportPath(dir: string, baseName: string): Promise<string> {
  let candidate = path.join(dir, baseName);
  const extension = path.extname(baseName);
  const stem = baseName.slice(0, -extension.length);
  let suffix = 2;

  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidate;
}

function logPathForReport(reportPath: string): string {
  const extension = path.extname(reportPath);
  return `${reportPath.slice(0, -extension.length)}.log.jsonl`;
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await appendFile(filePath, `${line}\n`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}
