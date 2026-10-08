/**
 * Pi places a steering message only after the current tool round, so a tool
 * that waits for agents would hold the user's steer back until the agents
 * answer. SteerWatch ends such waits as soon as the user steers.
 */

export class SteerWatch {
  private readonly controllers = new Set<AbortController>();

  /** A signal that aborts when the user steers; release it when done. */
  open(): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      signal: controller.signal,
      release: () => this.controllers.delete(controller),
    };
  }

  /** The user steered: end every open wait. */
  steer(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
