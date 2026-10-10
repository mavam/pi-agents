This release makes sure agent results reach Pi, even when Pi crashes or is busy. It also stops the panel from repeating while a call waits for agents.

## 🔧 Changes

### Stop repeating the panel while a call waits for agents

A call that waits for agents no longer draws a live tree of their states that repeats the panel right below it. While a graph's call waits, it shows the graph it started, with the agents each one waits for and their models, as it does without waiting; `send` and `wait` calls show just the call. The panel shows how the agents do. Once waiting stops, the call shows the agents' states at that point: how they finished, or, after a timeout, Esc, or a message from you, where they were.

*By @mavam in #81.*

## 🐞 Bug fixes

### Deliver results of agents that finish while the parent is busy

Results of agents that finish while Pi is working on a turn now reach the conversation once Pi is done. Before, such a result could stay "result queued" in the panel and never arrive, until something else happened while Pi was idle, such as another agent finishing, closing the attach view, or Pi waiting for agents. This happened more often alongside other extensions that do work when a turn ends. A result that waits for Pi to finish a compaction, for messages you queued, or for a tree navigation now arrives as well.

*By @mavam in #80.*

### Results no longer get lost when Pi crashes

A crash or a killed Pi process no longer loses an agent's result. Before, pi-agents considered a result delivered as soon as it handed the message to Pi, so if Pi went down before it saved the message, the result never arrived. Now a result counts as delivered only once your session contains it, as a message or in the answer of a call that waited for it. When you resume the session, results it already contains don't post again, and results it doesn't contain post again. After a crash, a result that a codemode script waited for may post again.

*By @mavam in #80.*

### Stop the clock for finished agents

The `/agents` overlay no longer keeps counting time for agents and graphs that finished. Each row shows how long it ran, from its start until it finished, and that time stays the same afterwards. If you resume an agent, its time picks up again and includes the pause.

*By @mavam.*
