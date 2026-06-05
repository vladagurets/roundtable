export type KeyName = "up" | "down" | "left" | "right" | "space" | "enter" | "ctrl-c";

export function parseKey(buffer: string): { key: KeyName; rest: string } | null {
  if (buffer.startsWith("\u001b[A") || buffer.startsWith("\u001bOA")) {
    return { key: "up", rest: buffer.slice(3) };
  }

  if (buffer.startsWith("\u001b[B") || buffer.startsWith("\u001bOB")) {
    return { key: "down", rest: buffer.slice(3) };
  }

  if (buffer.startsWith("\u001b[C") || buffer.startsWith("\u001bOC")) {
    return { key: "right", rest: buffer.slice(3) };
  }

  if (buffer.startsWith("\u001b[D") || buffer.startsWith("\u001bOD")) {
    return { key: "left", rest: buffer.slice(3) };
  }

  if (buffer.startsWith("\u0003")) {
    return { key: "ctrl-c", rest: buffer.slice(1) };
  }

  if (buffer.startsWith(" ")) {
    return { key: "space", rest: buffer.slice(1) };
  }

  if (buffer.startsWith("\r") || buffer.startsWith("\n")) {
    return { key: "enter", rest: buffer.slice(1) };
  }

  if (buffer.startsWith("\u001b")) {
    return null;
  }

  return null;
}

export const LIST_CONTROLS_HINT = "↑↓ move · Enter select";
