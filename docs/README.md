# gridsim docs

Source of truth for names, shapes, and flows. If code and these pages disagree, fix one of them before shipping. The live origin is https://gridstatemachine.com/. The hackathon submission checklist, quick start, and write-up are the root [README.md](../README.md).

| Doc | What it decides |
| --- | --- |
| [status.md](status.md) | What is built, what is only in the working tree, and the next slice |
| [architecture.md](architecture.md) | Layers, process, and the path from ERCOT to the map |
| [protocols.md](protocols.md) | State machine: when to push or pull, who answers |
| [api.md](api.md) | Public HTTP routes, bodies, and errors |
| [ercot-sources.md](ercot-sources.md) | Which ERCOT feeds are live, which need a key, and the raw fields |
| [contracts.md](contracts.md) | Component metrics, the state snapshot, and the log state |
| [metrics.md](metrics.md) | Tracked metrics, their buckets, and which control chart judges each one |
| [control-charts.md](control-charts.md) | The six chart families, limits, and rules |
| [database.md](database.md) | Tables, the machine-learning row, and the Postgres mapping |
| [data-model.md](data-model.md) | Entity diagram of the Supabase tables, and the disco sample |
| [llm.md](llm.md) | What OpenAI summarizes on a service ticket, and which action rows `LLM_URL` may write |
| [deploy.md](deploy.md) | Supabase migrations and the Render web service |
| [simulation.md](simulation.md) | Per-battery load, dispatch, and the trigger that starts maintenance |
| [gaps.md](gaps.md) | Facts we do not have yet |
