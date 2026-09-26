# gridsim docs

Source of truth for names, shapes, and flows. If code and these pages disagree, fix one of them before shipping.

| Doc | What it decides |
| --- | --- |
| [status.md](status.md) | What is built, what is only in the working tree, and the next slice |
| [architecture.md](architecture.md) | Layers, process, and the path from ERCOT to the map |
| [ercot-sources.md](ercot-sources.md) | Which ERCOT feeds are live, which need a key, and the raw fields |
| [contracts.md](contracts.md) | Component metrics, the state snapshot, and the log state |
| [control-charts.md](control-charts.md) | The six chart families, limits, and rules |
| [database.md](database.md) | Tables, the machine-learning row, and the Postgres mapping |
| [data-model.md](data-model.md) | Entity diagram of the Supabase tables, and the disco sample |
| [llm.md](llm.md) | What the model reads and which action rows it may write |
| [deploy.md](deploy.md) | Supabase migrations and the two Render services |
| [simulation.md](simulation.md) | Per-battery load, dispatch, and the scripted faults |
| [gaps.md](gaps.md) | Facts we do not have yet |
