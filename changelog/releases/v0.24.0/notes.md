Agents can now delegate: an agent splits its own task among helper agents that it starts and waits for, such as one helper per file it finds. This release also makes the agent panel and /agents easier to read and navigate, with Markdown results, folding, and Tab to switch between them.

## 🚀 Features

### Fold graphs and helpers with space

Press space in the agent panel or in `/agents` to fold a graph, or the helpers of an agent, to one line, and press it again to unfold. On a row inside a graph, space folds the graph it sits in, so you can tidy up from wherever you are. A folded row says how many agents it hides, and the panel and `/agents` remember what you folded.

*By @mavam in #74.*

### Let agents delegate to helper agents

Agents can now delegate: an agent you let delegate splits its own task while it works. It starts helper agents, waits for them, and continues with their results, for example one helper per file it finds and a helper that merges their reviews. Ask Pi for an agent that may delegate, or set `delegate: true` in a profile.

Helpers form a graph like the ones Pi starts, with the same edges. Their results go to the agent that started them, and only that agent's answer reaches Pi. The panel draws helpers below their agent, which shows their progress, such as `delegating · helpers 2/4`. A helper's full name starts with its agent's, such as `mapper.models`, but the tree leaves that part out below the agent. Helpers run on their agent's model and get only its tools, can't delegate themselves, and stop when you press Esc on their agent or stop a graph it belongs to. Agents survive restarts in the middle of delegating without starting their helpers twice.

*By @mavam in #74.*

### Open /agents with ← when no agents are open

Pressing ← in an empty editor, or Ctrl+Q, now opens `/agents` when no agents are open, so you can get back to agents that finished without typing the command. With open agents, both still focus the panel.

*By @mavam in #74.*

### Switch between the panel and /agents with Tab

Press Tab in the focused agent panel to open `/agents` at the agent you selected, and Tab in `/agents` to go back to the panel at the same agent. Going back works while agents are open; `/agents` only offers it then.

*By @mavam in #74.*

## 🔧 Changes

### Render tasks and results as Markdown in /agents

The detail pane of `/agents` now renders tasks and results as Markdown, so bold text, code, and lists read as they do in the conversation. An agent's task and its result each sit below a divider that names them, like the one under the table. The divider says "Result" while the answer replies to the task above it, and "Latest result" once the agent answered later messages.

A graph's detail is easier to scan: when its agents pass results to each other, it says the order in words, such as "Runs map, then api and tests at once, then merge." Each agent then gets a heading with its state, model, and spend, and its result follows indented below it. Long tasks and results end with a note on how to read the rest.

*By @mavam in #74.*

### Show more agents at once in /agents

`/agents` now shows more of a long list at once: its table takes up to half of the overlay instead of at most ten rows, and the details get the rest.

*By @mavam in #74.*

### Show what a call started instead of stale states

A call that starts agents without waiting no longer shows a snapshot of their states that goes stale right away. A graph's call now draws the graph right below its title, with the agents each one waits for and their models, but without glyphs, times, or usage; the panel shows how the agents do. A single agent's call shows just its arguments and task, without repeating its name. Expanded, a graph's call shows each agent's task as its own paragraph, and long lines wrap under their indentation.

*By @mavam in #74.*

## 🐞 Bug fixes

### Keep ← in /agents from focusing the hidden panel

Pressing ← inside `/agents` no longer focuses the agent panel hidden behind it, which left the panel focused after you closed `/agents`.

*By @mavam in #74.*

### Start agents when the model passes wait: false

Pi no longer fails to start an agent when the model passes `wait: false` for "don't wait", or quotes the number of seconds. Such values now mean no wait, and quoted numbers count.

*By @mavam.*
