import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..", "src");
const ALLOWED = [/^host\//, /^agents\//, /^ui\/attach\.ts$/];

function sources(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      return sources(path.join(dir, entry.name), `${relative}/`);
    return relative.endsWith(".ts") ? [relative] : [];
  });
}

describe("architecture", () => {
  test("only the host, agents, and attach view import pi-durable", () => {
    for (const file of sources(SRC)) {
      if (ALLOWED.some((pattern) => pattern.test(file))) continue;
      const text = readFileSync(path.join(SRC, file), "utf8");
      expect(
        /from "@earendil-works\/pi-durable/.test(text),
        `${file} imports pi-durable; go through AgentService`,
      ).toBe(false);
    }
  });

  test("tool views draw receipts, never live agents", () => {
    for (const file of ["ui/tool-views.ts", "agents/receipts.ts"]) {
      const text = readFileSync(path.join(SRC, file), "utf8");
      expect(/from "[^"]*\/service\.js"/.test(text), file).toBe(false);
    }
  });
});
