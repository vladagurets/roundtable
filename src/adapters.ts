import { spawn } from "node:child_process";
import { oneLine } from "./util/text.ts";
import { DEFAULT_MODELS, type AgentAdapter, type AdapterRunResult, type CliModels, type CliName, type StreamChunkHandler } from "./types.ts";

export interface CommandSpec {
  command: string;
  args: string[];
  stdin?: string;
}

export type CommandBuilder = (prompt: string, expectedDecision?: string) => CommandSpec;

export class ProcessAgentAdapter implements AgentAdapter {
  private readonly cli: CliName;
  private readonly buildCommand: CommandBuilder;

  constructor(cli: CliName, buildCommand: CommandBuilder) {
    this.cli = cli;
    this.buildCommand = buildCommand;
  }

  async runActor(prompt: string, onChunk?: StreamChunkHandler): Promise<AdapterRunResult> {
    const result = await runProcess(this.cli, this.buildCommand(prompt), onChunk);
    return {
      ...result,
      output: normalizeCliOutput(result.output, result.exitCode)
    };
  }

  async runLeader(prompt: string, expectedDecision: string, onChunk?: StreamChunkHandler): Promise<AdapterRunResult> {
    const result = await runProcess(this.cli, this.buildCommand(prompt, expectedDecision), onChunk);
    return {
      ...result,
      output: normalizeCliOutput(result.output, result.exitCode)
    };
  }
}

export function createAdapter(cli: CliName, model: string): AgentAdapter {
  switch (cli) {
    case "codex":
      return new ProcessAgentAdapter("codex", (prompt) => buildCodexCommand(prompt, model));
    case "claude":
      return new ProcessAgentAdapter("claude", (prompt) => buildClaudeCommand(prompt, model));
    case "gemini":
      return new ProcessAgentAdapter("gemini", (prompt) => buildGeminiCommand(prompt, model));
    case "cursor":
      return new ProcessAgentAdapter("cursor", (prompt, expectedDecision) =>
        expectedDecision ? buildCursorLeaderCommand(prompt, model) : buildCursorCommand(prompt, model));
  }
}

export function buildCodexCommand(prompt: string, model = DEFAULT_MODELS.codex): CommandSpec {
  return {
    command: "codex",
    args: [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--model",
      model,
      "--config",
      'model_reasoning_effort="high"',
      "-"
    ],
    stdin: prompt
  };
}

export function buildClaudeCommand(prompt: string, model = DEFAULT_MODELS.claude): CommandSpec {
  return {
    command: "claude",
    args: ["-p", "--permission-mode", "plan", "--output-format", "stream-json", "--verbose", "--model", model, "--thinking", "enabled"],
    stdin: prompt
  };
}

export function buildGeminiCommand(prompt: string, model = DEFAULT_MODELS.gemini): CommandSpec {
  return {
    command: "gemini",
    args: ["--prompt", prompt, "--approval-mode", "plan", "--output-format", "stream-json", "--model", model]
  };
}

export function buildCursorCommand(prompt: string, model = DEFAULT_MODELS.cursor): CommandSpec {
  return {
    command: "agent",
    args: [
      "-p",
      "--plan",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      model,
      prompt
    ]
  };
}

export function buildCursorLeaderCommand(prompt: string, model = DEFAULT_MODELS.cursor): CommandSpec {
  return {
    command: "agent",
    args: [
      "-p",
      "--mode",
      "ask",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      model,
      prompt
    ]
  };
}

export function normalizeCliOutput(raw: string, exitCode = 0): string {
  const streamJson = normalizeStreamJson(raw);
  if (streamJson !== raw.trim()) {
    return streamJson;
  }

  if (exitCode === 0) {
    return raw.trim();
  }

  return summarizeCliError(raw);
}

const IDLE_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 900_000;

async function runProcess(cli: CliName, spec: CommandSpec, onChunk?: StreamChunkHandler): Promise<AdapterRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let stderr = "";
    let settled = false;
    let killedReason: string | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: AdapterRunResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (maxTimer) {
        clearTimeout(maxTimer);
      }
      resolve(result);
    };

    const stopProcess = (reason: string): void => {
      killedReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };

    const resetIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        stopProcess(`produced no output for ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m`);
      }, IDLE_TIMEOUT_MS);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      resetIdleTimer();
      output += chunk;
      onChunk?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      resetIdleTimer();
      stderr += chunk;
      onChunk?.(chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (maxTimer) {
          clearTimeout(maxTimer);
        }
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      const combined = [output, stderr].filter(Boolean).join("\n").trim();
      if (killedReason) {
        const timeoutMessage = `${cli} ${killedReason} before the process was stopped. Check API quota, model availability, and network.`;
        finish({
          cli,
          output: combined ? `${combined}\n${timeoutMessage}` : timeoutMessage,
          exitCode: 1
        });
        return;
      }

      finish({
        cli,
        output: combined,
        exitCode: exitCode ?? 1
      });
    });

    resetIdleTimer();
    maxTimer = setTimeout(() => {
      stopProcess(`exceeded ${Math.round(MAX_TIMEOUT_MS / 60_000)}m total runtime`);
    }, MAX_TIMEOUT_MS);

    if (spec.stdin) {
      child.stdin.write(spec.stdin);
    }
    child.stdin.end();
  });
}

export function normalizeStreamJson(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const extracted: string[] = [];
  let sawJson = false;
  let finalResult = "";

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sawJson = true;
      if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
        finalResult = parsed.result;
        continue;
      }
      const text = extractText(parsed);
      if (text) {
        extracted.push(text);
      }
    } catch {
      continue;
    }
  }

  if (sawJson && finalResult) {
    return finalResult.trim();
  }

  if (sawJson && extracted.length > 0) {
    return extracted.join("").trim();
  }

  return raw.trim();
}

export function summarizeCliError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }

  const jsonMessages: string[] = [];
  const textLines: string[] = [];

  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const message = extractErrorMessage(parsed);
      if (message) {
        jsonMessages.push(message);
      }
      continue;
    } catch {
      textLines.push(candidate);
    }
  }

  const modelNotFound = textLines.find((line) => /ModelNotFoundError|Requested entity was not found|selected model .*may not exist|may not have access/i.test(line));
  if (modelNotFound) {
    return oneLine(modelNotFound);
  }

  const apiError = textLines.find((line) => /Error when talking|API Error|error:/i.test(line));
  if (apiError) {
    return oneLine(apiError);
  }

  if (jsonMessages.length > 0) {
    return jsonMessages.map(oneLine).join("\n");
  }

  return textLines.slice(0, 6).map(oneLine).join("\n");
}

function extractText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (record.type === "user") {
    return "";
  }

  const message = record.message as Record<string, unknown> | undefined;
  if (message && typeof message.role === "string" && message.role !== "assistant") {
    return "";
  }

  if (typeof record.role === "string" && record.role !== "assistant") {
    return "";
  }

  if (typeof record.content === "string") {
    return record.content;
  }
  if (typeof record.text === "string") {
    return record.text;
  }

  const delta = record.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.text === "string") {
    return delta.text;
  }

  const content = message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          return (part as Record<string, string>).text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

function extractErrorMessage(value: Record<string, unknown>): string {
  const error = value.error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
  }

  if (typeof value.message === "string" && typeof value.status === "string" && value.status === "error") {
    return value.message;
  }

  return "";
}
