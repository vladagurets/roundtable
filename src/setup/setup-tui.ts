import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  BOLD,
  RESET,
  boxRow,
  bottomLine,
  colorizeBorders,
  separator,
  topLine,
  wrapText
} from "../tui-frame.ts";
import { AltScreenSession, RawModeInput } from "../terminal/core.ts";
import { LIST_CONTROLS_HINT, parseKey, type KeyName } from "../terminal/keys.ts";
import { colorCli } from "../terminal/colors.ts";

const DIM = "\u001b[2m";
const ITALIC = "\u001b[3m";

interface SelectItem<T extends string> {
  label: string;
  value: T;
  selected?: boolean;
  detail?: string;
}

export class SetupTui {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly screen: AltScreenSession;
  private readonly rawInput: RawModeInput;
  private width: number;
  private pendingRender?: () => void;

  constructor(input: Readable, output: Writable) {
    this.input = input;
    this.output = output;
    this.screen = new AltScreenSession(output);
    this.rawInput = new RawModeInput(input);
    this.width = this.screen.width();
    this.screen.enter();
    this.screen.onResize(() => {
      this.width = this.screen.width();
      this.pendingRender?.();
    });
  }

  async select<T extends string>(title: string, hint: string, items: SelectItem<T>[]): Promise<T> {
    let index = Math.max(0, items.findIndex((item) => item.selected));

    return this.runInteractive(async (key) => {
      if (key === "up") {
        index = (index - 1 + items.length) % items.length;
      } else if (key === "down") {
        index = (index + 1) % items.length;
      } else if (key === "enter") {
        return items[index].value;
      }

      this.renderList(title, hint, items, index, (item, itemIndex) => {
        const pointer = itemIndex === index ? `${BOLD}>${RESET}` : " ";
        return `${pointer} ${item.label}`;
      });
      return undefined;
    }, () => {
      this.renderList(title, hint, items, index, (item, itemIndex) => {
        const pointer = itemIndex === index ? `${BOLD}>${RESET}` : " ";
        return `${pointer} ${item.label}`;
      });
    });
  }

  async selectWithBody<T extends string>(
    title: string,
    hint: string,
    body: string[],
    items: SelectItem<T>[]
  ): Promise<T> {
    let index = Math.max(0, items.findIndex((item) => item.selected));

    const render = () => {
      this.renderListWithBody(title, hint, body, items, index, (item, itemIndex) => {
        const pointer = itemIndex === index ? `${BOLD}>${RESET}` : " ";
        return `${pointer} ${item.label}`;
      });
    };

    return this.runInteractive(async (key) => {
      if (key === "up") {
        index = (index - 1 + items.length) % items.length;
      } else if (key === "down") {
        index = (index + 1) % items.length;
      } else if (key === "enter") {
        return items[index].value;
      }

      render();
      return undefined;
    }, render);
  }

  async selectBoolean(
    title: string,
    defaultValue: boolean,
    hint: string,
    yesDetail: string,
    noDetail: string
  ): Promise<boolean> {
    let value = defaultValue;

    const render = () => this.renderBoolean(title, value, hint, yesDetail, noDetail);

    return this.runInteractive(async (key) => {
      if (key === "left" || key === "right" || key === "space") {
        value = !value;
      } else if (key === "enter") {
        return value;
      }

      render();
      return undefined;
    }, render);
  }

  async readActorCount(defaultValue: number): Promise<number> {
    this.renderPrompt("Actor count", [
      italic("Independent participants that answer each leader question in parallel."),
      italic("More actors add perspectives; each runs as a separate subprocess.")
    ]);

    const rl = createInterface({ input: this.input, output: this.output });
    try {
      while (true) {
        const answer = (await rl.question(`How many actors? [${defaultValue}]: `)).trim();
        if (!answer) {
          return defaultValue;
        }

        if (!/^\d+$/.test(answer)) {
          this.output.write("Actor count must be a positive integer.\n");
          continue;
        }

        const count = Number(answer);
        if (count < 1) {
          this.output.write("Actor count must be at least 1.\n");
          continue;
        }

        return count;
      }
    } finally {
      rl.close();
    }
  }

  async readLimit(defaultValue: number): Promise<number> {
    this.renderPrompt("Question limit", [
      italic("Maximum leader questions before the final synthesis is written."),
      italic("Each round, all actors respond in parallel to the same question.")
    ]);

    const rl = createInterface({ input: this.input, output: this.output });
    try {
      while (true) {
        const answer = (await rl.question(`Debate question limit [${defaultValue}]: `)).trim();
        if (!answer) {
          return defaultValue;
        }

        if (!/^\d+$/.test(answer)) {
          this.output.write("Limit must be a positive integer.\n");
          continue;
        }

        const limit = Number(answer);
        if (limit < 1) {
          this.output.write("Limit must be at least 1.\n");
          continue;
        }

        return limit;
      }
    } finally {
      rl.close();
    }
  }

  async readLine(title: string, defaultValue: string, hint?: string): Promise<string> {
    if (hint) {
      this.renderPrompt(title, [italic(hint)]);
    } else {
      this.rawInput.disable();
      this.output.write("\n");
    }

    const rl = createInterface({ input: this.input, output: this.output });
    try {
      while (true) {
        const answer = (await rl.question(`${title} [${defaultValue}]: `)).trim();
        if (!answer) {
          return defaultValue;
        }

        return answer;
      }
    } finally {
      rl.close();
    }
  }

  async confirm(title: string, hint: string, lines: string[]): Promise<void> {
    const render = () => this.renderConfirm(title, hint, lines);

    await this.runInteractive(async (key) => {
      if (key === "enter") {
        return true;
      }

      render();
      return undefined;
    }, render);
  }

  close(): void {
    this.rawInput.disable();
    this.pendingRender = undefined;
    this.screen.dispose();
  }

  private async runInteractive<T>(
    handler: (key: KeyName) => Promise<T | undefined>,
    render: () => void
  ): Promise<T> {
    this.rawInput.enable();

    return new Promise((resolve, reject) => {
      let buffer = "";
      const keyQueue: KeyName[] = [];
      let handling = false;
      let settled = false;

      const cleanup = () => {
        this.input.off("data", onData);
        this.rawInput.disable();
      };

      const finish = (result: T) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };

      const processQueue = () => {
        if (handling || settled || keyQueue.length === 0) {
          return;
        }

        handling = true;
        const key = keyQueue.shift()!;

        handler(key).then((result) => {
          if (result !== undefined) {
            finish(result);
            return;
          }

          handling = false;
          processQueue();
        }).catch(fail);
      };

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();

        while (buffer.length > 0) {
          const parsed = parseKey(buffer);
          if (!parsed) {
            break;
          }

          buffer = parsed.rest;
          if (parsed.key === "ctrl-c") {
            fail(new Error("Setup cancelled"));
            return;
          }

          keyQueue.push(parsed.key);
        }

        processQueue();
      };

      this.pendingRender = render;
      render();
      this.input.on("data", onData);
    });
  }

  private renderBoolean(
    title: string,
    value: boolean,
    hint: string,
    yesDetail: string,
    noDetail: string
  ): void {
    this.renderFrame(title, [
      italic(hint),
      "",
      italic(value ? yesDetail : noDetail),
      "",
      italic("Space or arrow keys toggle, Enter confirms"),
      "",
      value ? `${BOLD}Yes${RESET}  ${DIM}No${RESET}` : `${DIM}Yes${RESET}  ${BOLD}No${RESET}`
    ]);
  }

  private renderConfirm(title: string, hint: string, lines: string[]): void {
    this.renderFrame(title, [
      italic(hint),
      "",
      ...lines,
      "",
      italic("Press Enter to save config/debate.json")
    ]);
  }

  private renderPrompt(title: string, lines: string[]): void {
    this.renderFrame(title, [...lines, ""]);
    this.rawInput.disable();
    this.output.write("\n");
  }

  private renderList<T extends string>(
    title: string,
    hint: string,
    items: SelectItem<T>[],
    index: number,
    renderItem: (item: SelectItem<T>, itemIndex: number) => string
  ): void {
    this.renderListWithBody(title, hint, [], items, index, renderItem);
  }

  private renderListWithBody<T extends string>(
    title: string,
    hint: string,
    body: string[],
    items: SelectItem<T>[],
    index: number,
    renderItem: (item: SelectItem<T>, itemIndex: number) => string
  ): void {
    const focused = items[index];
    const detail = focused?.detail ? [italic(focused.detail)] : [];

    this.renderFrame(title, [
      italic(hint),
      ...(body.length > 0 ? ["", ...body] : []),
      ...(detail.length > 0 ? ["", ...detail] : []),
      "",
      italic(LIST_CONTROLS_HINT),
      "",
      ...items.map((item, itemIndex) => renderItem(item, itemIndex))
    ]);
  }

  private renderFrame(title: string, bodyLines: string[]): void {
    const innerWidth = Math.max(48, this.width - 4);
    const rows = [
      topLine(innerWidth),
      boxRow(`${BOLD}${title}${RESET}`, innerWidth),
      separator(innerWidth),
      ...bodyLines.flatMap((line) => wrapText(line, innerWidth).map((wrapped) => boxRow(wrapped, innerWidth))),
      bottomLine(innerWidth)
    ];
    const phase = Date.now() / 30;
    const lines = colorizeBorders(rows, phase);

    this.screen.clearScreen();
    for (const line of lines) {
      this.output.write(`${line}\n`);
    }
  }
}

function italic(text: string): string {
  return `${ITALIC}${text}${RESET}`;
}

export { colorCli };
