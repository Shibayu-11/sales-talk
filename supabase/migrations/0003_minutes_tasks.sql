create table public.meeting_minutes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  meeting_id uuid not null references public.sales_meetings(id) on delete cascade,
  product_id text not null check (product_id in ('real_estate', 'kenko_keiei', 'hojokin')),
  summary text not null,
  agreed text[] not null default '{}',
  pending text[] not null default '{}',
  decisions text[] not null default '{}',
  numbers jsonb not null default '[]'::jsonb,
  risk_flags text[] not null default '{}',
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, meeting_id)
);

create table public.action_item_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  meeting_id uuid not null references public.sales_meetings(id) on delete cascade,
  owner text not null check (owner in ('own', 'customer', 'joint')),
  description text not null,
  due_kind text not null check (due_kind in ('explicit', 'inferred', 'none')),
  due_date date,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index meeting_minutes_tenant_generated_idx
  on public.meeting_minutes(tenant_id, generated_at desc);

create index action_item_tasks_tenant_due_idx
  on public.action_item_tasks(tenant_id, completed, due_date);

alter table public.meeting_minutes enable row level security;
alter table public.action_item_tasks enable row level security;

create policy "members can read meeting minutes"
  on public.meeting_minutes for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = meeting_minutes.tenant_id and tm.user_id = auth.uid()
  ));

create policy "users can manage own meeting minutes"
  on public.meeting_minutes for all
  using (exists (
    select 1 from public.sales_meetings sm
    where sm.id = meeting_minutes.meeting_id and sm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.sales_meetings sm
    where sm.id = meeting_minutes.meeting_id and sm.user_id = auth.uid()
  ));

create policy "members can read action item tasks"
  on public.action_item_tasks for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = action_item_tasks.tenant_id and tm.user_id = auth.uid()
  ));

create policy "users can manage own action item tasks"
  on public.action_item_tasks for all
  using (exists (
    select 1 from public.sales_meetings sm
    where sm.id = action_item_tasks.meeting_id and sm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.sales_meetings sm
    where sm.id = action_item_tasks.meeting_id and sm.user_id = auth.uid()
  ));
