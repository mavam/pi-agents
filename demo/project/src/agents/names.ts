const PATTERN = /^[a-z0-9-]+$/;

export function claimName(base: string, taken: Set<string>): string {
  if (!PATTERN.test(base)) throw new Error(`invalid name ${base}`);
  let name = base;
  for (let index = 2; taken.has(name); index++) name = `${base}-${index}`;
  return name;
}
