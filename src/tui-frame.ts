import type { Writable } from "node:stream";

export const RESET = "\u001b[0m";
export const BOLD = "\u001b[1m";
export const ALT_SCREEN_ON = "\u001b[?1049h";
export const ALT_SCREEN_OFF = "\u001b[?1049l";
export const CURSOR_HIDE = "\u001b[?25l";
export const CURSOR_SHOW = "\u001b[?25h";

const BORDER_CHARS = new Set(["╭", "╮", "╰", "╯", "─", "│", "├", "┤"]);

export const LOGO_LINES = [
  " ██████╗  ██████╗ ██╗   ██╗███╗   ██╗██████╗ ████████╗ █████╗ ██████╗ ██╗     ███████╗",
  " ██╔══██╗██╔═══██╗██║   ██║████╗  ██║██╔══██╗╚══██╔══╝██╔══██╗██╔══██╗██║     ██╔════╝",
  " ██████╔╝██║   ██║██║   ██║██╔██╗ ██║██║  ██║   ██║   ███████║██████╔╝██║     █████╗  ",
  " ██╔══██╗██║   ██║██║   ██║██║╚██╗██║██║  ██║   ██║   ██╔══██║██╔══██╗██║     ██╔══╝  ",
  " ██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║██████╔╝   ██║   ██║  ██║██████╔╝███████╗███████╗",
  " ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝"
];

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => line.length));

type TtyWritable = Writable & { columns?: number; rows?: number };

export function terminalWidth(output: Writable, max = 160): number {
  return Math.max(72, Math.min(max, (output as TtyWritable).columns ?? 100));
}

export function terminalHeight(output: Writable, min = 10, fallback = 24): number {
  return Math.max(min, (output as TtyWritable).rows ?? fallback);
}

export function topLine(innerWidth: number): string {
  return `╭${"─".repeat(innerWidth + 2)}╮`;
}

export function bottomLine(innerWidth: number): string {
  return `╰${"─".repeat(innerWidth + 2)}╯`;
}

export function separator(innerWidth: number): string {
  return `├${"─".repeat(innerWidth + 2)}┤`;
}

export function boxRow(content: string, innerWidth: number): string {
  return `│ ${padVisible(content, innerWidth)} │`;
}

export function padVisible(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) {
    return text;
  }

  return `${text}${" ".repeat(width - visible)}`;
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function wrapText(text: string, width: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }

  const lines: string[] = [];
  let line = "";

  for (const word of normalized.split(" ")) {
    if (visibleLength(word) > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(...chunkWord(word, width));
      continue;
    }

    const candidate = line ? `${line} ${word}` : word;
    if (visibleLength(candidate) <= width) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

function chunkWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function frameGradient(col: number, row: number, phase: number): string {
  const hue = (((col + row * 3) * 2.5 + phase) % 360 + 360) % 360;
  const [r, g, b] = hslToRgb(hue, 0.55, 0.78);
  return `\u001b[38;2;${r};${g};${b}m`;
}

function centeredLogoLines(frameWidth: number): string[] | null {
  if (frameWidth < LOGO_WIDTH) {
    return null;
  }

  const startCol = Math.floor((frameWidth - LOGO_WIDTH) / 2);
  return LOGO_LINES.map((line) => `${" ".repeat(startCol)}${line}`);
}

function colorizeGradientText(lines: string[], phase: number, rowOffset = 0): string[] {
  return lines.map((line, row) => {
    let result = "";
    let visibleCol = 0;
    for (const ch of line) {
      if (ch !== " ") {
        result += `${frameGradient(visibleCol, row + rowOffset, phase)}${ch}${RESET}`;
      } else {
        result += ch;
      }
      visibleCol++;
    }
    return result;
  });
}

function colorizeFrame(lines: string[], phase: number, rowOffset = 0): string[] {
  return lines.map((line, row) => {
    let result = "";
    let visibleCol = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\u001b") {
        const end = line.indexOf("m", i);
        if (end !== -1) {
          result += line.slice(i, end + 1);
          i = end;
          continue;
        }
      }
      const ch = line[i];
      if (BORDER_CHARS.has(ch)) {
        result += `${frameGradient(visibleCol, row + rowOffset, phase)}${ch}${RESET}`;
      } else {
        result += ch;
      }
      visibleCol++;
    }
    return result;
  });
}

export function colorizeBorders(lines: string[], phase: number): string[] {
  return colorizeFrame(lines, phase);
}

export function colorizeBordersWithLogo(tableLines: string[], phase: number): string[] {
  const frameWidth = tableLines[0]?.length ?? 0;
  const logo = centeredLogoLines(frameWidth);
  if (!logo) {
    return colorizeFrame(tableLines, phase);
  }

  const coloredLogo = colorizeGradientText(logo, phase);
  const coloredTable = colorizeFrame(tableLines, phase, logo.length + 1);
  return [...coloredLogo, "", ...coloredTable];
}
