import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  SpawnEngine,
  SpawnHandle,
  SpawnRequest,
} from "./engine/interface.js";

export class AgentManager {
  private readonly running = new Map<string, SpawnHandle>();

  constructor(private readonly engine: SpawnEngine) {}

  spawn(spec: SpawnRequest, ctx: ExtensionContext): SpawnHandle {
    const handle = this.engine.spawn(spec, ctx);
    this.running.set(handle.id, handle);
    void handle
      .wait()
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(handle.id);
      });
    return handle;
  }

  async abort(id: string): Promise<void> {
    await this.running.get(id)?.abort();
  }

  async abortAll(): Promise<void> {
    await Promise.all(
      [...this.running.values()].map((handle) => handle.abort()),
    );
  }

  getRunningIds(): string[] {
    return [...this.running.keys()];
  }
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const max = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOut>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: max }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as TIn, index);
      }
    }),
  );

  return results;
}
