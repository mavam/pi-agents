Agent graphs now wait for every agent to finish before reporting results, and stopping a graph halts remaining work. Simultaneous agent starts now preserve unique names and prevent ambiguous references.

## 🐞 Bug fixes

### Finish graphs only after their agents' work is done

A graph now counts as working until all of its agents' work is done, including messages you sent to one of its agents while the graph ran. Before, such a graph could show as finished and report its result too early, and stopping it then had no effect. Now its result arrives once everything finished, and stopping it stops the remaining work.

*By @mavam.*

### Keep agent names unique when agents start at once

Agents and graphs started at the same time no longer end up with the same name. Before, two agents started at once with the same name both succeeded, which made the name ambiguous. Now the second one fails with an error that the name is taken, and generated names stay distinct.

*By @mavam.*
