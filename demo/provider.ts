/**
 * A scripted model provider for the README demo. It registers the provider
 * `demo` with the models `sol`, `luna`, and `fable`, and answers Pi and its
 * agents from a script, so the recording is free, offline, and the same
 * every time. Agents still run for real: they read the files of
 * demo/project, start helpers, and pass results along.
 *
 * Load it next to pi-agents: `pi -e ./src/index.ts -e ./demo/provider.ts
 * --model demo/sol`. See demo/record.sh.
 */

import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How fast the models write; slow enough to watch, fast enough to wait. */
const TOKENS_PER_SECOND = 45;

type ToolArguments = Parameters<typeof fauxToolCall>[1];

const AUDIT: ToolArguments = {
  name: "audit",
  agents: [
    {
      name: "map",
      model: "luna",
      tools: ["read", "ls"],
      task: "Map the modules under src, one line each.",
    },
    {
      name: "core",
      model: "fable",
      tools: ["read"],
      delegate: true,
      after: ["map"],
      task: "Review src/agents: start one helper per file and a merge helper that ranks their findings.",
    },
    {
      name: "ui",
      model: "luna",
      tools: ["read"],
      delegate: true,
      after: ["map"],
      task: "Review src/ui: start one helper per file and a merge helper that ranks their findings.",
    },
    {
      name: "report",
      model: "sol",
      after: ["core", "ui"],
      task: "Write the top findings across the reviews, most severe first.",
    },
  ],
};

const FILES: Record<string, string[]> = {
  "src/agents": ["service", "graphs", "names"],
  "src/ui": ["panel", "attach"],
};

const FINDINGS: Record<string, string> = {
  service:
    "- **High:** `src/agents/service.ts:15` starts the graph with `void`, so a failed start is lost and the agent never reports back.",
  graphs:
    "- **High:** `src/agents/graphs.ts:3` starts agents one after another; independent agents should start at once.\n- **Low:** `src/agents/graphs.ts:9` logs a failed start instead of returning it.",
  names:
    "- **Medium:** `src/agents/names.ts:6` grows the suffix without a bound, so a long base name exceeds the name limit.",
  panel:
    "- **Medium:** `src/ui/panel.ts:10` repaints every 100 ms even when nothing changed.\n- **Low:** `src/ui/panel.ts:14` clears the whole screen instead of updating lines.",
  attach:
    "- **Medium:** `src/ui/attach.ts:3` cuts lines by characters, which breaks wide characters and escape sequences.",
};

const MERGED: Record<string, string> = {
  core: [
    "Ranked findings for `src/agents`:",
    "",
    "1. **High:** `service.ts:15` loses failed starts.",
    "2. **High:** `graphs.ts:3` starts agents one after another.",
    "3. **Medium:** `names.ts:6` lets generated names grow past the limit.",
  ].join("\n"),
  ui: [
    "Ranked findings for `src/ui`:",
    "",
    "1. **Medium:** `attach.ts:3` breaks wide characters.",
    "2. **Medium:** `panel.ts:10` repaints without changes.",
    "3. **Low:** `panel.ts:14` clears the whole screen.",
  ].join("\n"),
};

const REPORT = [
  "## Top findings",
  "",
  "1. **High:** `src/agents/service.ts:15` loses failed starts, so agents never report back.",
  "2. **High:** `src/agents/graphs.ts:3` starts independent agents one after another.",
  "3. **Medium:** `src/agents/names.ts:6` lets generated names exceed the limit.",
  "4. **Medium:** `src/ui/attach.ts:3` breaks wide characters.",
  "5. **Medium:** `src/ui/panel.ts:10` repaints without changes.",
].join("\n");

const JOKES: Record<string, string> = {
  rust: "Why did the Rust developer break up? The borrow checker said the relationship couldn't outlive its scope.",
  go: "A Go developer's favorite exercise? `if err != nil` reps, three sets of forty.",
  typescript:
    "TypeScript walks into a bar. The bartender asks for its order. It says: `any`, then regrets it.",
};

type Context = Parameters<
  Extract<FauxResponseStep, (...args: never[]) => unknown>
>[0];
type Message = Context["messages"][number];

function textOf(message: Message | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

const say = (text: string) => fauxAssistantMessage([fauxText(text)]);
const think = (headline: string, text: string) =>
  fauxAssistantMessage([fauxThinking(`**${headline}**`), fauxText(text)]);
const call = (
  headline: string,
  text: string,
  calls: Array<[string, ToolArguments]>,
) =>
  fauxAssistantMessage(
    [
      ...(headline ? [fauxThinking(`**${headline}**`)] : []),
      ...(text ? [fauxText(text)] : []),
      ...calls.map(([name, args]) => fauxToolCall(name, args)),
    ],
    { stopReason: "toolUse" },
  );

/** One answer, chosen by the newest message of the conversation. */
const respond: FauxResponseStep = (context) => {
  const messages = context.messages.filter((each) => each.role !== "system");
  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const tool = (last as { toolName?: string }).toolName;
    const task = textOf(messages.find((each) => each.role === "user"));
    if (tool === "agent_spawn_graph")
      return say(
        "The audit runs: **map** first, then **core** and **ui** fan out with one helper per file, and **report** ranks what they find.",
      );
    if (tool === "agent_spawn")
      return say(
        "Three luna agents are on it; their jokes arrive as they finish.",
      );
    if (tool === "delegate_graph")
      return say(MERGED[task.includes("src/ui") ? "ui" : "core"] ?? "");
    if (tool === "read") {
      const file = task.match(/src\/\w+\/(\w+)\.ts/)?.[1] ?? "";
      return say(FINDINGS[file] ?? "No findings.");
    }
    if (tool === "ls")
      return say(
        "- `src/agents`: the agent service, graphs, and names\n- `src/ui`: the panel and the attach view\n- `src/index.ts`: wires both together",
      );
    return say("Done.");
  }
  const text = textOf(last);
  const first = text.split("\n")[0] ?? "";

  // Pi.
  if (first.startsWith("Audit src"))
    return call("Planning the audit", "", [["agent_spawn_graph", AUDIT]]);
  if (first.startsWith("Graph audit"))
    return say(
      "The audit is in. The two high findings are both in `src/agents`: failed starts get lost, and independent agents start one after another.",
    );
  if (first.startsWith("Spawn three luna agents"))
    return call(
      "",
      "",
      Object.keys(JOKES).map((language) => [
        "agent_spawn",
        {
          name: language,
          model: "luna",
          task: `Tell a one-line joke about ${language === "typescript" ? "TypeScript" : language === "go" ? "Go" : "Rust"}.`,
        },
      ]),
    );
  if (first.startsWith("Agent ")) {
    // Jokes arrive one by one or together; Pi sums up once all are in.
    const arrived = messages.filter(
      (each) => each.role === "user" && textOf(each).startsWith("Agent "),
    ).length;
    const name = first.match(/^Agent (\w+)/)?.[1] ?? "";
    return say(
      arrived >= Object.keys(JOKES).length
        ? "All three jokes are in."
        : `The ${name === "typescript" ? "TypeScript" : name === "go" ? "Go" : "Rust"} joke is in.`,
    );
  }

  // Agents.
  if (first.startsWith("Map the modules"))
    return call("Listing the modules", "", [["ls", { path: "src" }]]);
  if (
    first.startsWith("Review src/agents:") ||
    first.startsWith("Review src/ui:")
  ) {
    const directory = first.startsWith("Review src/ui")
      ? "src/ui"
      : "src/agents";
    const files = FILES[directory] ?? [];
    return call("Splitting the review by file", "", [
      [
        "delegate_graph",
        {
          name: "files",
          agents: [
            ...files.map((file) => ({
              name: file,
              task: `Review ${directory}/${file}.ts and list findings with a bold severity and file:line.`,
            })),
            {
              name: "merge",
              task: "Rank their findings by severity.",
              after: files,
            },
          ],
        },
      ],
    ]);
  }
  if (first.startsWith("Review src/")) {
    const path = first.match(/src\/\w+\/\w+\.ts/)?.[0] ?? "src";
    return call(`Reading ${path.split("/").at(-1)}`, "", [["read", { path }]]);
  }
  if (first.startsWith("Rank their findings")) {
    const directory = text.includes("ui.") ? "ui" : "core";
    return think("Ranking by severity", MERGED[directory] ?? "");
  }
  if (first.startsWith("Write the top findings"))
    return think("Weighing the findings", REPORT);
  if (first.startsWith("Tell a one-line joke about")) {
    const language = first.slice(27, -1).toLowerCase();
    return think("Finding the punchline", JOKES[language] ?? "No joke today.");
  }
  return say("Done.");
};

export default function demoProvider(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: "demo",
    models: [
      { id: "sol", name: "Sol", reasoning: true },
      { id: "luna", name: "Luna", reasoning: true },
      { id: "fable", name: "Fable", reasoning: true },
    ],
    tokensPerSecond: TOKENS_PER_SECOND,
  });
  faux.setResponses(Array.from({ length: 1_000 }, () => respond));
  pi.registerProvider(faux.provider);
}
