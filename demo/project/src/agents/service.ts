import { runGraph } from "./graphs.js";
import { claimName } from "./names.js";

export class AgentService {
  private readonly agents = new Map<string, string>();

  static async open(): Promise<AgentService> {
    return new AgentService();
  }

  async spawn(task: string, name?: string): Promise<string> {
    const id = claimName(name ?? "agent", new Set(this.agents.keys()));
    this.agents.set(id, task);
    void runGraph([id]);
    return id;
  }
}
