export function oneLine(text: string, maxLength?: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (maxLength === undefined || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
