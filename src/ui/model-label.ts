function applyUniqueShortening(
  current: string[],
  shorten: (value: string, index: number) => string,
): string[] {
  const next = current.map(shorten);
  for (;;) {
    const groups = new Map<string, number[]>();
    next.forEach((value, index) => {
      const indices = groups.get(value) ?? [];
      indices.push(index);
      groups.set(value, indices);
    });
    const collisions = [...groups.values()].filter(
      (indices) => indices.length > 1,
    );
    if (collisions.length === 0) return next;
    let changed = false;
    for (const indices of collisions) {
      for (const index of indices) {
        if (next[index] !== current[index]) {
          next[index] = current[index] as string;
          changed = true;
        }
      }
    }
    if (!changed) return current;
  }
}

function cappedModel(value: string, tailChars = 0): string {
  if (value.length <= 14) return value;
  if (tailChars === 0) return `${value.slice(0, 13)}…`;
  return `${value.slice(0, 13 - tailChars)}…${value.slice(-tailChars)}`;
}

/**
 * Shorten a visible set of provider-qualified models without hiding
 * distinctions between providers, snapshots, or similarly named families.
 */
export function shortModels(models: string[]): Map<string, string> {
  const unique = [...new Set(models)];
  if (unique.length === 0) return new Map();

  const parsed = unique.map((model) => {
    const slash = model.indexOf("/");
    return slash < 0
      ? { provider: undefined, id: model }
      : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  });
  const idCounts = new Map<string, number>();
  for (const { id } of parsed) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  let shortened = parsed.map(({ provider, id }, index) => {
    if ((idCounts.get(id) ?? 0) === 1) return id;
    return provider
      ? `${provider.split("/").at(-1)}:${id}`
      : (unique[index] ?? id);
  });
  // A provider discriminator should be enough, but retain canonical ids if an
  // unusual provider shape still collides.
  if (new Set(shortened).size !== shortened.length) shortened = [...unique];

  shortened = applyUniqueShortening(shortened, (value) =>
    value.replace(/-\d{8}$/, ""),
  );
  const beforeFamilyCompression = [...shortened];
  shortened = applyUniqueShortening(shortened, (value) =>
    value.replace(/^claude-/, "").replace(/^gemini-/, "g"),
  );

  let capped = shortened.map((value) => cappedModel(value));
  const capGroups = new Map<string, number[]>();
  capped.forEach((value, index) => {
    const indices = capGroups.get(value) ?? [];
    indices.push(index);
    capGroups.set(value, indices);
  });
  for (const indices of capGroups.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      capped[index] = cappedModel(beforeFamilyCompression[index] as string);
    }
  }
  // If long names still share the same head, reserve progressively more of
  // the cap for their tail until the visible labels separate.
  for (
    let tailChars = 1;
    new Set(capped).size !== capped.length && tailChars <= 6;
    tailChars += 1
  ) {
    capped = applyUniqueShortening(beforeFamilyCompression, (value) =>
      cappedModel(value, tailChars),
    );
  }
  if (new Set(capped).size !== capped.length) {
    capped = capped.map((value, index) => {
      const suffix = String(index + 1);
      return `${value.slice(0, Math.max(1, 13 - suffix.length))}…${suffix}`;
    });
  }

  return new Map(
    unique.map((model, index) => [model, capped[index] as string]),
  );
}
