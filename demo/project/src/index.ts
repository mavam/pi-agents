import { AgentService } from "./agents/service.js";
import { Panel } from "./ui/panel.js";

export async function main(): Promise<void> {
  const service = await AgentService.open();
  new Panel(service).mount();
}
