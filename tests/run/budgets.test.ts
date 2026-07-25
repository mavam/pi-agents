import { describe, expect, test } from "bun:test";
import { DEFAULT_BUDGETS } from "../../src/model/ast.js";
import {
  BudgetActor,
  BudgetExceededError,
  validateBudgets,
} from "../../src/run/budgets.js";

describe("validateBudgets", () => {
  test("accepts a full set of well-formed budgets", () => {
    expect(() =>
      validateBudgets({
        maxDepth: 2,
        maxParallelism: 4,
        maxIterations: 10,
        maxAgents: 20,
        maxTurns: 30,
        maxTokens: 100_000,
        maxAgentDuration: 90.5,
        maxDuration: 600,
        maxCost: 2.5,
      }),
    ).not.toThrow();
  });

  test("maxAgents is non-negative; other counts are positive integers", () => {
    expect(() => validateBudgets({ maxAgents: 0 })).not.toThrow();
    expect(() => validateBudgets({ maxAgents: -1 })).toThrow(
      "must be an integer >= 0",
    );
    expect(() => validateBudgets({ maxAgents: 1.5 })).toThrow(
      "must be an integer >= 0",
    );
    expect(() => validateBudgets({ maxTurns: 0 })).toThrow(
      "must be an integer >= 1",
    );
    expect(() => validateBudgets({ maxTurns: 2.5 })).toThrow(
      "must be an integer >= 1",
    );
    expect(() => validateBudgets({ maxTokens: -1 })).toThrow(
      "must be an integer >= 1",
    );
  });

  test("duration and cost budgets are positive finite numbers", () => {
    expect(() => validateBudgets({ maxDuration: 0.5 })).not.toThrow();
    expect(() => validateBudgets({ maxCost: 0.01 })).not.toThrow();
    expect(() => validateBudgets({ maxDuration: 0 })).toThrow(
      "must be a number > 0",
    );
    expect(() => validateBudgets({ maxAgentDuration: -3 })).toThrow(
      "must be a number > 0",
    );
    expect(() => validateBudgets({ maxCost: Number.NaN })).toThrow(
      "must be a number > 0",
    );
  });
});

describe("BudgetActor", () => {
  test("defaults bound turns but leave duration/tokens/cost open", () => {
    const actor = new BudgetActor();
    expect(actor.limits.maxTurns).toBe(DEFAULT_BUDGETS.maxTurns);
    expect(actor.limits.maxDuration).toBeUndefined();
    expect(actor.limits.maxAgentDuration).toBeUndefined();
    expect(actor.limits.maxTokens).toBeUndefined();
    expect(actor.limits.maxCost).toBeUndefined();
  });

  test("denied agent acquisitions do not consume the budget", async () => {
    const prohibited = new BudgetActor({ maxAgents: 0 });
    await expect(prohibited.acquireAgent(0)).rejects.toThrow(
      "agent execution prohibited (maxAgents: 0)",
    );
    expect(await prohibited.usedAgents()).toBe(0);

    const capped = new BudgetActor({ maxAgents: 2 });
    await capped.acquireAgent(0);
    await capped.acquireAgent(0);
    await expect(capped.acquireAgent(0)).rejects.toThrow(
      "agent budget exceeded (maxAgents: 2)",
    );
    expect(await capped.usedAgents()).toBe(2);
  });

  test("recordUsage trips the token budget", async () => {
    const actor = new BudgetActor({ maxTokens: 1000 });
    await actor.recordUsage({ tokens: 600, cost: 0 });
    await expect(actor.recordUsage({ tokens: 600, cost: 0 })).rejects.toThrow(
      new BudgetExceededError("token budget exceeded (maxTokens: 1000)"),
    );
  });

  test("recordUsage trips the cost budget", async () => {
    const actor = new BudgetActor({ maxCost: 0.05 });
    await actor.recordUsage({ tokens: 0, cost: 0.04 });
    await expect(actor.recordUsage({ tokens: 0, cost: 0.02 })).rejects.toThrow(
      "cost budget exceeded (maxCost: $0.05)",
    );
  });

  test("recordUsage is unbounded without limits", async () => {
    const actor = new BudgetActor();
    await expect(
      actor.recordUsage({ tokens: 10_000_000, cost: 500 }),
    ).resolves.toBeUndefined();
  });
});
