# Deploy

One Render web service and one Supabase project. The service runs the simulation and serves the map on the same origin. Supabase is the table a controller reads and writes. The browser talks only to that service. The service-role key stays in the service environment.

Do not paste the service-role key, the OpenAI key, the ERCOT password, or the subscription key into chat. Set them in the Render dashboard.

## 1. Supabase

Create a project. In the SQL editor, run these files in order:

1. `supabase/migrations/20260926043000_dispatch.sql`
2. `supabase/migrations/20260926043100_llm_read.sql`
3. `supabase/migrations/20260926043200_actions.sql`
4. `supabase/migrations/20260926160000_usage_temp.sql`

The eight tables those files create, and what a disco records into them, are [data-model.md](data-model.md).

Or, with the Supabase CLI linked to that project, run `supabase db push` from the repo root.

Copy the project URL and the service-role key into the bot's environment only. Row level security is on and there is no anon policy.

## 2. Render

`render.yaml` describes one Python web service named `gridsim`. From the Render dashboard, create a blueprint that points at this repo, or create that service by hand with the same commands.

**gridsim** (Python web service)

- Build: `pip install -r requirements.txt`
- Start: `uvicorn gridsim.api:app --host 0.0.0.0 --port $PORT`
- Health check: `/api/scene`
- Environment:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `LLM_URL` if a model endpoint is ready. Leave it empty until then.
  - `OPENAI_API_KEY` and `OPENAI_MODEL` if an escalated ticket should ask OpenAI for the note. `OPENAI_MODEL` defaults to `gpt-4o-mini`. Leave the key empty until then. Do not paste the key into chat.
  - `ERCOT_USERNAME`, `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY` if you want official prices. The public dashboard works without them.

Leave `SERVE_STATIC` unset. The default serves `web/` from this same process, and `API_BASE` in `web/config.js` stays empty so the page calls its own origin. Set `SERVE_STATIC=0` and `WEB_ORIGIN` only if a different origin must host the map.

The service disk is ephemeral. Supabase is the record of actions, market rows, and usage hours. A restart rebuilds the fleet in memory and then catches up from `unit_actions`.

The free instance has 512 MB. Startup builds all 3000 homes, including the 30-hour chart trace and the 180-tick log, before the port opens. The log is packed into fixed records so that fits in about 220 MB before the web server is counted. A log line `Out of memory (used over 512Mi)` during "Waiting for application startup" means that packing no longer fits, or `FLEET_SIZE` was raised past 3000. The paid starter instance is the same 512 MB. A larger instance is the next step only after the fleet itself no longer fits.

That same startup line stays up while the history is filled. On a laptop that takes about two minutes. The free CPU is slower, so leave the deploy on that line until the port opens.

The map polls `/api/scene` on that same origin. The side panel starts open. It shows the price and day shape, Fleet manager and Maintenance manager with the latest step and a timer, and Maintenance alerts for homes past a limit.

## 3. Check

Open the service URL. The fleet should appear, and the Now block should show a rate. Insert a service from the Supabase SQL editor:

```sql
insert into unit_actions (id, site_id, kind, status, actor, note)
values ('service-aus-0004', 'aus-0004', 'scheduled_service', 'pending', 'llm', 'Cabinet inspection');
```

Within one tick the bot marks it active, `aus-0004` goes grey on the map, and Maintenance manager shows the row with status active and its note. One to two hours later the bot writes `return_online` with the same actor and the base is online again.
