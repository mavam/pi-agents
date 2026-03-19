import { describe, expect, it } from "bun:test";
import { formatFailureReason, isChildProcessRunning } from "../src/index.ts";

describe("formatFailureReason", () => {
  it("converts missing API key stacktrace to a human-facing message", () => {
    const raw = [
      "Error: No API key found for azure-openai-responses.",
      "",
      "Use /login or set an API key environment variable.",
      "    at AgentSession.prompt (file:///path/agent-session.js:556:19)",
      "    at async runPrintMode (file:///path/print-mode.js:69:9)",
      "Node.js v25.6.1",
    ].join("\n");

    const result = formatFailureReason(raw, "openai-codex/gpt-5.3-codex-spark");

    expect(result).toContain(
      'No credentials configured for provider "azure-openai-responses".',
    );
    expect(result).toContain("Run /login or configure the provider API key");
    expect(result).not.toContain("at AgentSession.prompt");
    expect(result).not.toContain("Node.js v25.6.1");
  });

  it("strips stack frames from generic failures", () => {
    const raw = [
      "Error: Command failed",
      "    at run (file:///tmp/x.js:1:1)",
      "    at main (file:///tmp/y.js:2:2)",
    ].join("\n");

    const result = formatFailureReason(raw);
    expect(result).toBe("Error: Command failed");
  });
});

describe("isChildProcessRunning", () => {
  it("returns true only when neither exitCode nor signalCode is set", () => {
    expect(isChildProcessRunning({ exitCode: null, signalCode: null })).toBe(
      true,
    );
    expect(isChildProcessRunning({ exitCode: 0, signalCode: null })).toBe(
      false,
    );
    expect(
      isChildProcessRunning({ exitCode: null, signalCode: "SIGTERM" }),
    ).toBe(false);
  });
});
