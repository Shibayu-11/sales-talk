create table public.knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id text not null check (product_id in ('real_estate', 'kenko_keiei', 'hojokin')),
  objection_type text not null,
  trigger text not null,
  response text not null,
  reasoning text not null default '',
  risk_flags text[] not null default '{}',
  source_meeting_id uuid references public.sales_meetings(id) on delete set null,
  embedding vector(1024),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.knowledge_review_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_meeting_id uuid references public.sales_meetings(id) on delete set null,
  product_id text not null check (product_id in ('real_estate', 'kenko_keiei', 'hojokin')),
  objection_type text not null,
  trigger text not null,
  response text not null,
  reasoning text not null default '',
  ai_filter text not null check (ai_filter in ('auto_approve_candidate', 'needs_review', 'reject_candidate')),
  reject_reason text,
  created_at timestamptz not null default now()
);

create index knowledge_entries_tenant_product_idx
  on public.knowledge_entries(tenant_id, product_id, objection_type);

create index knowledge_entries_embedding_hnsw_idx
  on public.knowledge_entries using hnsw (embedding vector_cosine_ops);

create index knowledge_entries_pgroonga_idx
  on public.knowledge_entries
  using pgroonga ((trigger || ' ' || response || ' ' || reasoning));

create index knowledge_review_queue_tenant_filter_idx
  on public.knowledge_review_queue(tenant_id, ai_filter, created_at desc);

alter table public.knowledge_entries enable row level security;
alter table public.knowledge_review_queue enable row level security;

create policy "members can read knowledge entries"
  on public.knowledge_entries for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_entries.tenant_id and tm.user_id = auth.uid()
  ));

create policy "admins can manage knowledge entries"
  on public.knowledge_entries for all
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_entries.tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_entries.tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
  ));

create policy "members can read review queue"
  on public.knowledge_review_queue for select
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_review_queue.tenant_id and tm.user_id = auth.uid()
  ));

create policy "admins can manage review queue"
  on public.knowledge_review_queue for all
  using (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_review_queue.tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = knowledge_review_queue.tenant_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
  ));
