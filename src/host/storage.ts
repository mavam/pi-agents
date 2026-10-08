/**
 * Agent storage: JSONL files for sessions that can resume, memory for
 * ephemeral ones.
 */

import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export type { Storage };

/** JSONL storage in `<directory>/storage`, or memory without a directory. */
export async function openStorage(
  directory: string | undefined,
): Promise<Storage> {
  if (directory === undefined) return new MemoryStorage();
  return openNodeJsonlStorage(
    path.join(directory, "storage"),
    BACKGROUND_CONTEXT,
  );
}
