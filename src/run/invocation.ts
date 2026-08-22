/**
 * The one place that decides what an agent invocation actually runs with.
 *
 * Preflight and the runner both go through `resolveInvocation`, so their
 * precedence, discovery, and error text cannot drift. Nothing else computes an
 * effective cwd or scope, and nothing else resolves a profile or a skill.
 *
 * Precedence for every setting: call site → named profile → session default.
 * List fields (`skills`, `tools`) replace rather than merge, and an explicit
 * `[]` clears what the profile declared — so presence, not truthiness, decides
 * whether a list was supplied.
 */

import {
  type Agent,
  type Diagnostic,
  discoverAgents,
  formatAgentList,
  resolveAgentByName,
  type Thinking,
} from "../catalog/agents.js";
import {
  discoverSkills,
  type ResolvedSkill,
  resolveSkills,
  type SkillCatalog,
  skillNames,
} from "../catalog/skills.js";
import {
  type AgentExecutionOptions,
  DELEGATED_AGENT_FORBIDDEN_TOOLS,
  effectiveScope,
  type Scope,
} from "../model/ast.js";

/** Session-level fallbacks for invocations that set none. */
export interface SpawnDefaults {
  model?: string;
  thinking?: string;
}

/** An invocation as written: a profile selector plus execution overrides. */
export interface InvocationCall extends AgentExecutionOptions {
  /** Profile name; absent runs an anonymous ad-hoc agent. */
  profile?: string;
}

/** Run-level context every invocation resolves against. */
export type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; message: string };

export type ResolveModel = (ref: string) => ModelResolution;

export interface InvocationContext {
  /** Run-level working directory; a call may override it. */
  cwd: string;
  /** Run-level discovery scope; a call may override it. */
  scope: Scope;
  /** Project trust; when false, scope clamps to user. */
  trusted: boolean;
  defaults?: SpawnDefaults;
  /** Validate explicit node/profile models and return their canonical form. */
  resolveModel?: ResolveModel;
  /** Shared discovery caches; pass one instance per run. */
  catalogs: CatalogCache;
}

/** Everything needed to spawn: no further lookups, no further I/O. */
export interface ResolvedInvocation {
  /** The named profile, when the call selected one. */
  profile?: Agent;
  cwd: string;
  scope: Scope;
  model?: string;
  thinking?: string;
  /** Effective skills with instructions loaded, ready to render. */
  skills: ResolvedSkill[];
  /** Whether the child Pi process must suppress its ambient skill catalog. */
  disableSkillDiscovery: boolean;
  /** Effective tool allowlist; `[]` means no tools, undefined means default. */
  tools?: string[];
}

/**
 * Resolution result. Failures carry the effective cwd and scope so callers can
 * report context without recomputing it, and the problem strings themselves so
 * every caller reports identical text.
 */
export type InvocationResolution =
  | { ok: true; invocation: ResolvedInvocation }
  | { ok: false; cwd: string; scope: Scope; problems: string[] };

/** Apply runtime invocation rules when deciding whether to advertise a profile. */
export function createProfileAvailability(
  context: InvocationContext,
): (profile: Agent) => string | undefined {
  return (profile) => {
    const resolution = resolveInvocation({ profile: profile.name }, context);
    return resolution.ok ? undefined : resolution.problems.join("; ");
  };
}

/**
 * Per-run memo of agent and skill discovery, keyed by effective cwd and scope.
 * Skill bodies are cached inside each `SkillCatalog`, so preflight's read
 * serves the later spawn and a wide `map` re-reads nothing.
 */
export class CatalogCache {
  private readonly agents = new Map<
    string,
    { agents: Agent[]; diagnostics: Diagnostic[] }
  >();
  private readonly skills = new Map<string, SkillCatalog>();
  /** Skill directory scans performed; observable so tests can prove elision. */
  skillScans = 0;

  agentsFor(cwd: string, scope: Scope) {
    const key = `${cwd}|${scope}`;
    let discovery = this.agents.get(key);
    if (!discovery) {
      discovery = discoverAgents(cwd, scope);
      this.agents.set(key, discovery);
    }
    return discovery;
  }

  skillsFor(cwd: string, scope: Scope): SkillCatalog {
    const key = `${cwd}|${scope}`;
    let catalog = this.skills.get(key);
    if (!catalog) {
      catalog = discoverSkills(cwd, scope);
      this.skills.set(key, catalog);
      this.skillScans += 1;
    }
    return catalog;
  }
}

function where(cwd: string, scope: Scope): string {
  return `(cwd: ${cwd}, scope: ${scope})`;
}

/** Resolve a profile name, or describe why it could not be resolved. */
function resolveProfile(
  name: string,
  cwd: string,
  scope: Scope,
  catalogs: CatalogCache,
): { profile: Agent } | { problem: string } {
  const discovery = catalogs.agentsFor(cwd, scope);
  const resolution = resolveAgentByName(discovery.agents, name);
  switch (resolution.kind) {
    case "exact":
    case "case_insensitive":
      return { profile: resolution.agent };
    case "ambiguous":
      return {
        problem: `ambiguous profile '${name}' ${where(cwd, scope)} (${resolution.matches
          .map((a) => a.name)
          .join(", ")})`,
      };
    case "missing": {
      // A same-named file that failed to parse is the likely culprit — surface
      // its diagnostic instead of a bare "unknown".
      const related = discovery.diagnostics.filter((diagnostic) =>
        diagnostic.filePath.includes(`/${name}.`),
      );
      const hint = related.length
        ? ` (${related.map((d) => `${d.filePath}: ${d.message}`).join("; ")})`
        : "";
      return {
        problem: `unknown profile '${name}' ${where(cwd, scope)}. Remove 'profile' for a one-off agent. Available profiles: ${formatAgentList(discovery.agents)}${hint}`,
      };
    }
  }
}

/**
 * Compute the effective configuration for one invocation, resolving its
 * profile and skills. Returns problems rather than throwing so preflight can
 * collect every failure in a flow before anything spawns.
 */
export function resolveInvocation(
  call: InvocationCall,
  context: InvocationContext,
): InvocationResolution {
  const cwd = call.cwd ?? context.cwd;
  const scope = effectiveScope(call.scope, context.trusted, context.scope);
  const problems: string[] = [];

  let profile: Agent | undefined;
  if (call.profile !== undefined) {
    const resolution = resolveProfile(
      call.profile,
      cwd,
      scope,
      context.catalogs,
    );
    if ("profile" in resolution) profile = resolution.profile;
    else problems.push(resolution.problem);
  }

  // Presence, not truthiness: `[]` is an explicit "none", not "inherit".
  const requested =
    call.skills !== undefined ? call.skills : (profile?.skills ?? []);
  // The common case asks for no skills. Scanning the catalog then would walk
  // and read skill directories for nothing.
  let resolved: ResolvedSkill[] = [];
  if (requested.length > 0) {
    const catalog = context.catalogs.skillsFor(cwd, scope);
    const outcome = resolveSkills(requested, catalog);
    resolved = outcome.resolved;
    for (const failure of outcome.failures) {
      problems.push(
        failure.reason === "unknown"
          ? `unknown skill '${failure.name}' ${where(cwd, scope)}. Available: ${
              skillNames(catalog).join(", ") || "none"
            }`
          : `unreadable skill '${failure.name}' ${where(cwd, scope)}: ${failure.message}`,
      );
    }
  }

  let model = call.model ?? profile?.model ?? context.defaults?.model;
  const modelNeedsValidation =
    call.model !== undefined || profile?.model !== undefined;
  if (model !== undefined && modelNeedsValidation && context.resolveModel) {
    const resolution = context.resolveModel(model);
    if (resolution.ok) model = resolution.model;
    else problems.push(`${resolution.message} ${where(cwd, scope)}`);
  }

  const tools = call.tools !== undefined ? call.tools : profile?.tools;
  const forbiddenTools = tools?.filter((tool) =>
    DELEGATED_AGENT_FORBIDDEN_TOOLS.some((forbidden) => forbidden === tool),
  );
  if (forbiddenTools && forbiddenTools.length > 0) {
    problems.push(
      `delegated agents cannot use orchestration tools (${forbiddenTools.join(", ")}) ${where(cwd, scope)}; compose the work in the parent flow with workflow, parallel, map, loop, or while nodes`,
    );
  }

  if (problems.length > 0) return { ok: false, cwd, scope, problems };

  return {
    ok: true,
    invocation: {
      profile,
      cwd,
      scope,
      model,
      thinking:
        call.thinking ?? profile?.thinking ?? context.defaults?.thinking,
      skills: resolved,
      // An anonymous call with no selection retains normal Pi discovery.
      // Every explicit call-site list and every named profile is closed.
      disableSkillDiscovery: call.skills !== undefined || profile !== undefined,
      tools,
    },
  };
}

/** `resolveInvocation` for callers that want a throw, such as the runner. */
export function resolveInvocationOrThrow(
  call: InvocationCall,
  context: InvocationContext,
): ResolvedInvocation {
  const resolution = resolveInvocation(call, context);
  if (!resolution.ok) throw new Error(resolution.problems.join("; "));
  return resolution.invocation;
}

export type { Thinking };
