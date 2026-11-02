/** Schema helpers for tool parameters and results. */

import { type TUnsafe, Type } from "typebox";

/**
 * A string enum as `{ type: "string", enum }`, which every provider takes,
 * unlike TypeBox's `anyOf` of literals. Like pi-ai's `StringEnum`, which
 * builds a pi-schema schema since Pi 1.5, but typed for TypeBox.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
  });
}
