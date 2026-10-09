export function attach(name: string, lines: string[]): string {
  const width = process.stdout.columns;
  return lines.map((line) => line.slice(0, width)).join("\n") + name;
}
