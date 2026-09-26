-- Actions a controller takes on one base unit, and the add-ons the disco meters.
-- scheduled_service takes the base offline until ends_at. The bot then inserts
-- return_online. install_addon and remove_addon change site_addons.

create table if not exists addon_catalog (
  addon_id text primary key,
  name text not null,
  role text not null check (role in ('source', 'load')),
  tracked_by text not null default 'disco' check (tracked_by = 'disco'),
  rated_kw double precision not null
);

insert into addon_catalog (addon_id, name, role, tracked_by, rated_kw) values
  ('solar', 'Solar', 'source', 'disco', 5.0),
  ('ev_charger', 'Car charger', 'load', 'disco', 7.2)
on conflict (addon_id) do nothing;

create table if not exists site_addons (
  site_id text not null,
  addon_id text not null references addon_catalog (addon_id),
  installed_at timestamptz not null default now(),
  primary key (site_id, addon_id)
);

create table if not exists unit_actions (
  id text primary key,
  ts timestamptz not null default now(),
  site_id text not null,
  kind text not null check (kind in (
    'scheduled_service', 'set_signal', 'install_addon', 'remove_addon', 'return_online'
  )),
  status text not null check (status in ('pending', 'active', 'done', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  note text not null default '',
  payload jsonb not null default '{}'::jsonb,
  actor text not null check (actor in ('llm', 'api', 'sim'))
);

create index if not exists unit_actions_open on unit_actions (status, ts);
create index if not exists unit_actions_site on unit_actions (site_id, ts desc);

alter table addon_catalog enable row level security;
alter table site_addons enable row level security;
alter table unit_actions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'unit_actions'
  ) then
    alter publication supabase_realtime add table unit_actions;
  end if;
end $$;
