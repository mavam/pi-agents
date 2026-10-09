export async function runGraph(agents: string[]): Promise<void> {
  for (const agent of agents) {
    await start(agent);
  }
}

async function start(agent: string): Promise<void> {
  const response = await fetch(`http://localhost/agents/${agent}`);
  if (!response.ok) console.log("failed to start", agent);
}
