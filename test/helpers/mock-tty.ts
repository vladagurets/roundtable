import { Readable, Writable } from "node:stream";

export class MockTtyInput extends Readable {
  isTTY = true;

  _read(): void {}

  setRawMode(_mode: boolean): void {}
}

export class TtyMemoryWritable extends Writable {
  isTTY = true;
  columns = 100;
  text = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    callback();
  }
}

export class MemoryWritable extends Writable {
  text = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    callback();
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
