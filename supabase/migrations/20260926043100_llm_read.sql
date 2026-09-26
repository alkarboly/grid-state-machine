-- What a controller reads before it decides. One market row per tick, the
-- latest battery for the units the bot is publishing, and one usage row per
-- site per hour. See docs/llm.md.

create table if not exists market_ticks (
  ts timestamptz primary key,
  demand_mw double precision,
  demand_percentile double precision,
  storage_gen_mw double precision,
  rate_usd_mwh double precision not null,
  rate_basis text not null check (rate_basis in ('ercot', 'simulated')),
  frequency_hz double precision not null,
  signal text not null,
  intensity double precision not null,
  source text not null,
  mean_soc_pct double precision not null,
  offline integer not null,
  units integer not null
);

create table if not exists unit_latest (
  site_id text primary key,
  ts timestamptz not null,
  soc_kwh double precision not null,
  soc_pct double precision not null,
  availability text not null check (availability in ('online', 'offline')),
  signal text not null,
  charge_kw double precision not null,
  discharge_kw double precision not null,
  load_kw double precision not null,
  temp_c double precision not null,
  addons_json jsonb not null default '[]'::jsonb
);

create table if not exists usage_hours (
  ts timestamptz not null,
  site_id text not null,
  hour integer not null,
  load_kwh double precision not null,
  import_kwh double precision not null,
  export_kwh double precision not null,
  solar_kwh double precision not null,
  ev_kwh double precision not null,
  primary key (ts, site_id)
);

create index if not exists usage_hours_site on usage_hours (site_id, ts desc);

alter table market_ticks enable row level security;
alter table unit_latest enable row level security;
alter table usage_hours enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'market_ticks'
  ) then
    alter publication supabase_realtime add table market_ticks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'unit_latest'
  ) then
    alter publication supabase_realtime add table unit_latest;
  end if;
end $$;
