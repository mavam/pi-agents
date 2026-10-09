import type { AgentService } from "../agents/service.js";

export class Panel {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly service: AgentService) {}

  mount(): void {
    this.timer = setInterval(() => this.render(), 100);
  }

  private render(): void {
    process.stdout.write(`\x1b[2J${String(this.service)}`);
  }
}
