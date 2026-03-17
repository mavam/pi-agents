export const ROOT_FLOW_PATH = "flow";

export function sequenceStepPath(parent: string, index: number): string {
  return `${parent}.steps[${index}]`;
}

export function forkBranchPath(parent: string, branchKey: string): string {
  return `${parent}.branches[${JSON.stringify(branchKey)}]`;
}

export function loopBodyPath(parent: string): string {
  return `${parent}.body`;
}

export function syntheticChildPath(parent: string, name: string): string {
  return `${parent}.${name}`;
}
