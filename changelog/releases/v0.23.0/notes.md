Pi can now compose agents into graphs that pass their results to each other, so a merging agent, a pipeline, or a diamond does the work and Pi gets one answer. This release also lets you steer Pi while it waits for agents and fixes two glitches in the agent panel and the attach view.

## 🚀 Features

### Start graphs of agents that pass results to each other

Pi can now start a graph of agents that work together and pass their results to each other. Ask for it, for example "three agents review src/run, src/ui, and src/host, and a fourth merges their findings", and Pi uses the new `agent_spawn_graph` tool. Agents run in parallel, and an agent that waits for others starts once they finished and receives their final messages. Fan-outs with a merging agent, pipelines such as plan → implement → review, and diamonds all work.

Only the agents nothing waits for report back, as one message. With a single merging agent, Pi gets just its answer, attributed to it, and the results in between stay in the graph. When an agent fails, the agents waiting for it still start with the results that did arrive; an agent is skipped only when none of its inputs answered. A graph runs to the end by default; ask Pi to stop everything on the first failure instead. `agent_wait`, `agent_status`, and `agent_stop` accept graph names, and stopping a graph stops all of its agents.

The panel draws a graph as a tree: `○` marks an agent waiting for its inputs, and `←` names the agents whose results it receives. `/agents` shows each graph's shape, such as `map → {api, tests} → merge`. A graph's agents are ordinary agents: attach to them, message them, and keep talking to them after the graph finished. Graphs survive restarts like agents do: agents that already finished don't work again, and no agent gets its task twice.

*By @mavam in #71.*

## 🐞 Bug fixes

### Fix duplicate working spinner in the attach view

Attaching to an agent no longer shows two working spinners. The attach view now hides Pi's own working indicator while it is open and restores it when you detach.

*By @mavam.*

### Steer Pi while it waits for agents

Steering Pi while it waits for agents now works. Before, a message you sent while Pi waited for an agent's result stayed queued until the agent answered. Now your message ends the wait right away and Pi responds to it. The agents keep working, and their results arrive as messages. Follow-up messages still wait until Pi is done.

*By @mavam in #71.*

### Stop agents from the panel without attaching to them

Confirming a stop from the agent panel now stops the agent. Before, pressing Enter in the confirmation also reached the panel, which attached to the selected agent instead of stopping it.

*By @mavam.*
