import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSubprocessSpawnEngine } from "../../src/engine/subprocess.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("real Pi RPC result submission", () => {
  function spawnFixture(env: Record<string, string> = {}) {
    const piHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-rpc-"));
    tempDirs.push(piHome);
    const fixture = path.join(
      import.meta.dir,
      "fixtures",
      "faux-result-provider.ts",
    );
    const engine = createSubprocessSpawnEngine({
      extraExtensionPaths: [fixture],
    });
    return engine.spawn({
      agent: "rpc-test",
      task: "Submit the fixture result.",
      cwd: path.resolve(import.meta.dir, "../.."),
      model: "faux/faux-1",
      tools: [],
      resultMode: "json",
      env: {
        PATH: `${path.resolve(import.meta.dir, "../../node_modules/.bin")}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: piHome,
        PI_OFFLINE: "1",
        ...env,
      },
    });
  }

  test("captures details, settles, and terminates without another model turn", async () => {
    const handle = spawnFixture();
    await expect(handle.wait()).resolves.toMatchObject({
      value: { source: "real-rpc", ok: true },
      exitCode: 0,
      usage: { turns: 1 },
    });
    expect(handle.status).toBe("completed");
  }, 10_000);

  test("lets Pi reject an invalid submission and accepts its retry", async () => {
    const handle = spawnFixture({ PI_AGENTS_FAUX_INVALID_FIRST: "1" });
    await expect(handle.wait()).resolves.toMatchObject({
      value: { source: "real-rpc", ok: true },
      exitCode: 0,
      usage: { turns: 2 },
    });
    expect(handle.status).toBe("completed");
  }, 10_000);
});
