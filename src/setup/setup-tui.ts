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

const DIM_STYLE = "\u001b[2m";
const ITALIC = "\u001b[3m";
const MIN_LIST_VISIBLE = 3;
const SCROLL_INDICATOR_RESERVE = 2;

interface SelectItem<T extends string> {
  label: string;
  value: T;
  selected?: boolean;
  detail?: string;
}

export interface ListViewport {
  scrollTop: number;
  maxVisible: number;
  visibleStart: number;
  visibleEnd: number;
  above: number;
  below: number;
}

export function computeListViewport(
  index: number,
  scrollTop: number,
  itemCount: number,
  terminalRows: number,
  headerWrappedLineCount: number
): ListViewport {
  const frameOverhead = 4;
  const budget = Math.max(MIN_LIST_VISIBLE, terminalRows - frameOverhead - headerWrappedLineCount);
  let maxVisible = Math.max(1, budget - SCROLL_INDICATOR_RESERVE);
  let viewport = resolveListViewport(index, scrollTop, itemCount, maxVisible);

  const indicatorLines =
    (viewport.above > 0 ? 1 : 0) +
    (viewport.below > 0 ? 1 : 0);
  maxVisible = Math.max(1, budget - indicatorLines);
  viewport = resolveListViewport(index, scrollTop, itemCount, maxVisible);

  return viewport;
}

export function resolveListViewport(
  index: number,
  scrollTop: number,
  itemCount: number,
  maxVisible: number
): ListViewport {
  const visible = Math.max(1, maxVisible);
  let top = scrollTop;

  if (index < top) {
    top = index;
  } else if (index >= top + visible) {
    top = index - visible + 1;
  }

  top = Math.max(0, Math.min(top, Math.max(0, itemCount - visible)));
  const visibleStart = top;
  const visibleEnd = Math.min(itemCount, top + visible);

  return {
    scrollTop: top,
    maxVisible: visible,
    visibleStart,
    visibleEnd,
    above: visibleStart,
    below: itemCount - visibleEnd
  };
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
    let scrollTop = 0;

    return this.runInteractive(async (key) => {
      if (key === "up") {
        index = (index - 1 + items.length) % items.length;
      } else if (key === "down") {
        index = (index + 1) % items.length;
      } else if (key === "enter") {
        return items[index].value;
      }

      scrollTop = this.renderSelectableList(title, hint, [], items, index, scrollTop);
      return undefined;
    }, () => {
      scrollTop = this.renderSelectableList(title, hint, [], items, index, scrollTop);
    });
  }

  async selectWithBody<T extends string>(
    title: string,
    hint: string,
    body: string[],
    items: SelectItem<T>[]
  ): Promise<T> {
    let index = Math.max(0, items.findIndex((item) => item.selected));
    let scrollTop = 0;

    const render = () => {
      scrollTop = this.renderSelectableList(title, hint, body, items, index, scrollTop);
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
      value ? `${BOLD}Yes${RESET}  ${DIM_STYLE}No${RESET}` : `${DIM_STYLE}Yes${RESET}  ${BOLD}No${RESET}`
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

  private renderSelectableList<T extends string>(
    title: string,
    hint: string,
    body: string[],
    items: SelectItem<T>[],
    index: number,
    scrollTop: number
  ): number {
    const focused = items[index];
    const detail = focused?.detail ? [italic(focused.detail)] : [];
    const headerLines = [
      italic(hint),
      ...(body.length > 0 ? ["", ...body] : []),
      ...(detail.length > 0 ? ["", ...detail] : []),
      "",
      italic(LIST_CONTROLS_HINT)
    ];
    const innerWidth = Math.max(48, this.width - 4);
    const headerWrappedLineCount = headerLines.flatMap((line) => wrapText(line, innerWidth)).length;
    const viewport = computeListViewport(
      index,
      scrollTop,
      items.length,
      this.screen.height(),
      headerWrappedLineCount
    );

    const itemLines: string[] = [];
    if (viewport.above > 0) {
      itemLines.push(`${DIM_STYLE}  ↑ ${viewport.above} more${RESET}`);
    }

    for (let itemIndex = viewport.visibleStart; itemIndex < viewport.visibleEnd; itemIndex += 1) {
      const item = items[itemIndex];
      const pointer = itemIndex === index ? `${BOLD}>${RESET}` : " ";
      itemLines.push(`${pointer} ${item.label}`);
    }

    if (viewport.below > 0) {
      itemLines.push(`${DIM_STYLE}  ↓ ${viewport.below} more${RESET}`);
    }

    this.renderFrame(title, [...headerLines, "", ...itemLines]);
    return viewport.scrollTop;
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
