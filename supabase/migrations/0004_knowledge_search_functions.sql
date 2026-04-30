create or replace function public.match_knowledge_entries(
  p_tenant_id uuid,
  p_product_id text,
  p_query_embedding vector(1024),
  p_match_count integer default 5
)
returns table (
  id uuid,
  product_id text,
  objection_type text,
  trigger text,
  response text,
  reasoning text,
  risk_flags text[],
  created_at timestamptz,
  updated_at timestamptz,
  rank integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    ranked.id,
    ranked.product_id,
    ranked.objection_type,
    ranked.trigger,
    ranked.response,
    ranked.reasoning,
    ranked.risk_flags,
    ranked.created_at,
    ranked.updated_at,
    row_number() over (order by ranked.distance asc, ranked.updated_at desc)::integer as rank
  from (
    select
      ke.id,
      ke.product_id,
      ke.objection_type,
      ke.trigger,
      ke.response,
      ke.reasoning,
      ke.risk_flags,
      ke.created_at,
      ke.updated_at,
      ke.embedding <=> p_query_embedding as distance
    from public.knowledge_entries ke
    where ke.tenant_id = p_tenant_id
      and ke.product_id = p_product_id
      and ke.embedding is not null
    order by ke.embedding <=> p_query_embedding asc, ke.updated_at desc
    limit least(greatest(p_match_count, 1), 20)
  ) ranked;
$$;

create or replace function public.search_knowledge_entries_text(
  p_tenant_id uuid,
  p_product_id text,
  p_query text,
  p_match_count integer default 5
)
returns table (
  id uuid,
  product_id text,
  objection_type text,
  trigger text,
  response text,
  reasoning text,
  risk_flags text[],
  created_at timestamptz,
  updated_at timestamptz,
  rank integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    ranked.id,
    ranked.product_id,
    ranked.objection_type,
    ranked.trigger,
    ranked.response,
    ranked.reasoning,
    ranked.risk_flags,
    ranked.created_at,
    ranked.updated_at,
    row_number() over (order by ranked.updated_at desc)::integer as rank
  from (
    select
      ke.id,
      ke.product_id,
      ke.objection_type,
      ke.trigger,
      ke.response,
      ke.reasoning,
      ke.risk_flags,
      ke.created_at,
      ke.updated_at
    from public.knowledge_entries ke
    where ke.tenant_id = p_tenant_id
      and ke.product_id = p_product_id
      and (ke.trigger || ' ' || ke.response || ' ' || ke.reasoning) &@~ p_query
    order by ke.updated_at desc
    limit least(greatest(p_match_count, 1), 20)
  ) ranked;
$$;

grant execute on function public.match_knowledge_entries(uuid, text, vector, integer) to authenticated;
grant execute on function public.search_knowledge_entries_text(uuid, text, text, integer) to authenticated;
