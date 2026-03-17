import type { RunResultDetails } from "./types.js";

interface LiveRunRecord {
  readonly runId: string;
  readonly sessionFile?: string;
  readonly stop: () => void;
  readonly snapshot: () => RunResultDetails | undefined;
}

export class LiveRunRegistry {
  private readonly records = new Map<string, LiveRunRecord>();

  register(record: LiveRunRecord): void {
    this.records.set(record.runId, record);
  }

  remove(runId: string): void {
    this.records.delete(runId);
  }

  get(runId: string): LiveRunRecord | undefined {
    return this.records.get(runId);
  }

  has(runId: string): boolean {
    return this.records.has(runId);
  }

  stop(runId: string): boolean {
    const record = this.records.get(runId);
    if (!record) return false;
    record.stop();
    return true;
  }

  listSnapshots(): RunResultDetails[] {
    return [...this.records.values()]
      .map((record) => record.snapshot())
      .filter(
        (snapshot): snapshot is RunResultDetails => snapshot !== undefined,
      );
  }

  listRunIds(): string[] {
    return [...this.records.keys()];
  }

  stopAll(): void {
    for (const record of this.records.values()) {
      record.stop();
    }
  }
}
