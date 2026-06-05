import type { Readable, Writable } from "node:stream";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CURSOR_HIDE,
  CURSOR_SHOW,
  terminalWidth
} from "../tui-frame.ts";

type TtyReadable = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export class AltScreenSession {
  private readonly output: Writable;
  private readonly interactive: boolean;
  private altScreen = false;
  private resizeListener?: () => void;

  constructor(output: Writable) {
    this.output = output;
    this.interactive = Boolean((output as Writable & { isTTY?: boolean }).isTTY);
  }

  get isInteractive(): boolean {
    return this.interactive;
  }

  width(max = 160): number {
    return terminalWidth(this.output, max);
  }

  enter(): void {
    if (this.interactive && !this.altScreen) {
      this.output.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
      this.altScreen = true;
    }
  }

  clearScreen(): void {
    this.output.write("\u001b[H\u001b[J");
  }

  onResize(handler: () => void): void {
    if (!this.interactive) {
      return;
    }

    this.resizeListener = handler;
    process.on("SIGWINCH", this.resizeListener);
  }

  dispose(): void {
    if (this.resizeListener) {
      process.off("SIGWINCH", this.resizeListener);
      this.resizeListener = undefined;
    }

    if (this.interactive && this.altScreen) {
      this.output.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
      this.altScreen = false;
    }
  }
}

export class RawModeInput {
  private readonly input: TtyReadable;
  private enabled = false;

  constructor(input: Readable) {
    this.input = input;
  }

  enable(): void {
    if (this.enabled) {
      return;
    }

    if (this.input.isTTY) {
      this.input.setRawMode?.(true);
    }

    this.input.resume();
    this.enabled = true;
  }

  disable(): void {
    if (!this.enabled) {
      return;
    }

    if (this.input.isTTY) {
      this.input.setRawMode?.(false);
    }

    this.enabled = false;
  }
}
