-- Fleet call bus. The bot writes dispatch_ticks. A controller writes dispatch_orders.
-- The browser never connects here. Row level security is on and there is no
-- anon policy, so only the service role used by the bot can read or write.

create table if not exists dispatch_orders (
  ts timestamptz primary key default now(),
  signal text not null check (signal in ('push', 'pull', 'hold', 'auto')),
  intensity double precision
);

create table if not exists dispatch_ticks (
  ts timestamptz primary key,
  demand_mw double precision,
  demand_percentile double precision,
  storage_gen_mw double precision,
  frequency_hz double precision not null,
  signal text not null,
  intensity double precision not null,
  source text not null,
  zones_json text not null,
  pushing integer not null,
  pulling integer not null,
  holding integer not null,
  discharge_kw double precision not null,
  charge_kw double precision not null,
  load_kw double precision not null,
  mean_soc_pct double precision not null,
  stored_kwh double precision not null,
  alarms integer not null
);

alter table dispatch_orders enable row level security;
alter table dispatch_ticks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'dispatch_ticks'
  ) then
    alter publication supabase_realtime add table dispatch_ticks;
  end if;
end $$;
