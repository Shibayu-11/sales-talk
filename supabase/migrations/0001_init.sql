create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pgroonga;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.user_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  selected_product_id text check (selected_product_id in ('real_estate', 'kenko_keiei', 'hojokin')),
  consent_notice_mode text not null default 'verbal' check (consent_notice_mode in ('verbal', 'zoom_background', 'sdk')),
  hotkeys jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.sales_meetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  product_id text not null check (product_id in ('real_estate', 'kenko_keiei', 'hojokin')),
  title text,
  started_at timestamptz not null,
  ended_at timestamptz,
  transcript_redacted text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index tenant_members_user_id_idx on public.tenant_members(user_id);
create index user_settings_tenant_user_idx on public.user_settings(tenant_id, user_id);
create index sales_meetings_tenant_started_idx on public.sales_meetings(tenant_id, started_at desc);
create index audit_logs_tenant_created_idx on public.audit_logs(tenant_id, created_at desc);

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.user_settings enable row level security;
alter table public.sales_meetings enable row level security;
alter table public.audit_logs enable row level security;

create policy "tenant members can read tenants"
  on public.tenants for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = tenants.id and tm.user_id = auth.uid()
  ));

create policy "users can read own memberships"
  on public.tenant_members for select
  using (user_id = auth.uid());

create policy "members can read settings in tenant"
  on public.user_settings for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = user_settings.tenant_id and tm.user_id = auth.uid()
  ));

create policy "users can upsert own settings"
  on public.user_settings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "members can read tenant meetings"
  on public.sales_meetings for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = sales_meetings.tenant_id and tm.user_id = auth.uid()
  ));

create policy "users can manage own meetings"
  on public.sales_meetings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "members can read audit logs"
  on public.audit_logs for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = audit_logs.tenant_id and tm.user_id = auth.uid()
  ));
