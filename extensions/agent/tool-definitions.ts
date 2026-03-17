import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentRunDetails } from "./types.js";

export type ToolPromptMetadata = {
  promptSnippet?: string;
  promptGuidelines?: string[];
};

export class UnknownAgentError extends Error {
  readonly details: AgentRunDetails;

  constructor(message: string, details: AgentRunDetails) {
    super(message);
    this.name = "UnknownAgentError";
    this.details = details;
  }
}

const ScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agents to load. "user" reads ~/.pi/agents. "project" reads nearest .pi/agents. "both" merges both (project wins).',
  default: "both",
});

export const AgentParamsSchema = Type.Object({
  name: Type.String({
    description: "Name of the agent definition from markdown frontmatter",
  }),
  task: Type.String({ description: "Task to delegate" }),
  scope: Type.Optional(ScopeSchema),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the delegated agent process",
    }),
  ),
});

const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const OutputModeSchema = StringEnum(["text", "json"] as const);
const JoinModeSchema = StringEnum(["all", "any", "quorum"] as const);
const JoinFailureSchema = StringEnum(["failFast", "collectErrors"] as const);

const ContinueSpecSchema = Type.Object({
  kind: Type.Literal("result_field"),
  path: Type.String({
    description: "Field path to inspect on the body result",
  }),
  equals: Type.Boolean({
    description: "Loop while the field equals this value",
  }),
});

const JoinReducerSchema = Type.Union([
  Type.Object({ kind: Type.Literal("collect") }),
  Type.Object({
    kind: Type.Literal("agent"),
    agent: Type.String({ description: "Agent used to reduce branch results" }),
    task: Type.String({ description: "Reducer task prompt" }),
    output: Type.Optional(OutputModeSchema),
  }),
]);

const SpawnShorthandSchema = Type.Object({
  id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String({ description: "Agent name to execute" })),
  task: Type.Optional(
    Type.String({ description: "Task prompt passed to the agent" }),
  ),
  cwd: Type.Optional(Type.String()),
  scope: Type.Optional(ScopeSchema),
  output: Type.Optional(OutputModeSchema),
});

const FlowSpecSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({
      kind: Type.Literal("spawn"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      agent: Type.String({ description: "Agent name to execute" }),
      task: Type.String({ description: "Task prompt passed to the agent" }),
      cwd: Type.Optional(Type.String()),
      scope: Type.Optional(ScopeSchema),
      output: Type.Optional(OutputModeSchema),
    }),
    SpawnShorthandSchema,
    Type.Object({
      kind: Type.Literal("sequence"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      steps: Type.Array(Self, {
        description:
          "Nodes executed in order; the last output becomes the sequence output",
      }),
    }),
    Type.Object({
      kind: Type.Literal("fork"),
      id: Type.Optional(
        Type.String({
          description: "Optional fork identifier for downstream joins",
        }),
      ),
      label: Type.Optional(Type.String()),
      agent: Type.Optional(
        Type.String({
          description: "Default agent inherited by branch spawns",
        }),
      ),
      taskTemplate: Type.Optional(
        Type.String({
          description:
            "Default task template for branch spawns. Use {branch} as a placeholder.",
        }),
      ),
      cwd: Type.Optional(Type.String()),
      scope: Type.Optional(ScopeSchema),
      output: Type.Optional(OutputModeSchema),
      branches: Type.Record(
        Type.String(),
        Type.Union([Self, Type.String(), SpawnShorthandSchema]),
        {
          description:
            "Named branches executed concurrently. Branch values may be full flow specs, spawn shorthands, or agent-name strings.",
        },
      ),
      concurrency: Type.Optional(PositiveIntegerSchema),
    }),
    Type.Object({
      kind: Type.Literal("join"),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      from: Type.String({ description: "Fork id to join" }),
      mode: JoinModeSchema,
      quorum: Type.Optional(PositiveIntegerSchema),
      reducer: Type.Optional(JoinReducerSchema),
      onFailure: Type.Optional(JoinFailureSchema),
    }),
    Type.Object({
      kind: Type.Literal("loop"),
      id: Type.String({ description: "Unique loop identifier" }),
      label: Type.Optional(Type.String()),
      body: Self,
      maxIterations: PositiveIntegerSchema,
      continueWhen: Type.Optional(ContinueSpecSchema),
    }),
  ]),
);

export const WorkflowParamsSchema = Type.Object({
  label: Type.Optional(
    Type.String({ description: "Optional label shown in workflow UI" }),
  ),
  flow: FlowSpecSchema,
  budgets: Type.Optional(
    Type.Object({
      maxDepth: Type.Optional(PositiveIntegerSchema),
      maxChildren: Type.Optional(PositiveIntegerSchema),
      maxParallelism: Type.Optional(PositiveIntegerSchema),
      maxIterations: Type.Optional(PositiveIntegerSchema),
    }),
  ),
  scope: Type.Optional(ScopeSchema),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for relative agent discovery and tasks",
    }),
  ),
});
