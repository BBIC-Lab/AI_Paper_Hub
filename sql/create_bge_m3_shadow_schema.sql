-- ============================================================
-- bge-m3 1024 维影子表 / RPC（arXiv + bioRxiv）
-- ============================================================
-- 用途：并行重建 BAAI/bge-m3 embedding，不修改、不删除现有 384 维表。
-- 建议顺序：
--   1) 先执行本文件创建 *_bge_m3 表、FTS 索引、RPC 与联合 view；
--   2) 全量 upsert 完成后，再执行 create_bge_m3_shadow_hnsw_indexes.sql。
-- ============================================================

create extension if not exists vector;

create table if not exists public.arxiv_papers_bge_m3 (
  id text primary key,
  source text not null default 'arxiv',
  source_paper_id text,
  doi text,
  version text,
  title text not null,
  abstract text,
  authors jsonb not null default '[]'::jsonb,
  primary_category text,
  categories jsonb not null default '[]'::jsonb,
  published timestamptz,
  link text,
  embedding vector(1024),
  embedding_model text,
  embedding_dim int,
  embedding_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.biorxiv_papers_bge_m3 (
  id text primary key,
  source text not null default 'biorxiv',
  source_paper_id text,
  doi text,
  version text,
  title text not null,
  abstract text,
  authors jsonb not null default '[]'::jsonb,
  primary_category text,
  categories jsonb not null default '[]'::jsonb,
  published timestamptz,
  link text,
  embedding vector(1024),
  embedding_model text,
  embedding_dim int,
  embedding_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists arxiv_papers_bge_m3_source_published_idx
  on public.arxiv_papers_bge_m3 (source, published desc);

create index if not exists arxiv_papers_bge_m3_published_idx
  on public.arxiv_papers_bge_m3 (published desc);

create index if not exists arxiv_papers_bge_m3_title_abstract_fts_idx
  on public.arxiv_papers_bge_m3
  using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(abstract, '')));

create index if not exists biorxiv_papers_bge_m3_source_published_idx
  on public.biorxiv_papers_bge_m3 (source, published desc);

create index if not exists biorxiv_papers_bge_m3_published_idx
  on public.biorxiv_papers_bge_m3 (published desc);

create index if not exists biorxiv_papers_bge_m3_title_abstract_fts_idx
  on public.biorxiv_papers_bge_m3
  using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(abstract, '')));

-- arXiv exact vector recall on 1024-d bge-m3 embeddings.
create or replace function public.match_arxiv_papers_bge_m3_exact(
  query_embedding vector(1024),
  match_count int,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8
)
language sql stable
as $$
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.arxiv_papers_bge_m3 p
  where p.embedding is not null
    and (filter_published_start is null or p.published >= filter_published_start)
    and (filter_published_end is null or p.published < filter_published_end)
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_arxiv_papers_bge_m3_bm25(
  query_text text,
  match_count int,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8,
  score float8
)
language sql stable
as $$
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    0::float8 as similarity,
    ts_rank_cd(
      to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, '')),
      plainto_tsquery('english', query_text)
    ) as score
  from public.arxiv_papers_bge_m3 p
  where to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, ''))
        @@ plainto_tsquery('english', query_text)
    and (filter_published_start is null or p.published >= filter_published_start)
    and (filter_published_end is null or p.published < filter_published_end)
  order by score desc
  limit match_count;
$$;

-- bioRxiv exact vector recall on 1024-d bge-m3 embeddings.
create or replace function public.match_biorxiv_papers_bge_m3_exact(
  query_embedding vector(1024),
  match_count int,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8
)
language sql stable
as $$
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.biorxiv_papers_bge_m3 p
  where p.embedding is not null
    and (filter_published_start is null or p.published >= filter_published_start)
    and (filter_published_end is null or p.published < filter_published_end)
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_biorxiv_papers_bge_m3_bm25(
  query_text text,
  match_count int,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8,
  score float8
)
language sql stable
as $$
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    0::float8 as similarity,
    ts_rank_cd(
      to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, '')),
      plainto_tsquery('english', query_text)
    ) as score
  from public.biorxiv_papers_bge_m3 p
  where to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, ''))
        @@ plainto_tsquery('english', query_text)
    and (filter_published_start is null or p.published >= filter_published_start)
    and (filter_published_end is null or p.published < filter_published_end)
  order by score desc
  limit match_count;
$$;

create or replace view public.multi_source_papers_bge_m3 as
select
  p.id,
  p.source,
  p.source_paper_id,
  p.doi,
  p.version,
  p.title,
  p.abstract,
  p.authors,
  p.primary_category,
  p.categories,
  p.published,
  p.link,
  p.embedding,
  p.embedding_model,
  p.embedding_dim,
  p.embedding_updated_at,
  p.updated_at
from public.arxiv_papers_bge_m3 p

union all

select
  p.id,
  p.source,
  p.source_paper_id,
  p.doi,
  p.version,
  p.title,
  p.abstract,
  p.authors,
  p.primary_category,
  p.categories,
  p.published,
  p.link,
  p.embedding,
  p.embedding_model,
  p.embedding_dim,
  p.embedding_updated_at,
  p.updated_at
from public.biorxiv_papers_bge_m3 p;

create or replace function public.match_multi_source_papers_bge_m3_exact(
  query_embedding vector(1024),
  match_count int,
  filter_sources text[] default null,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8
)
language sql stable
as $$
  with selected as (
    select *
    from public.multi_source_papers_bge_m3 p
    where (filter_sources is null or p.source = any(filter_sources))
      and (filter_published_start is null or p.published >= filter_published_start)
      and (filter_published_end is null or p.published < filter_published_end)
  )
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    1 - (p.embedding <=> query_embedding) as similarity
  from selected p
  where p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_multi_source_papers_bge_m3_bm25(
  query_text text,
  match_count int,
  filter_sources text[] default null,
  filter_published_start timestamptz default null,
  filter_published_end timestamptz default null
)
returns table (
  id text,
  title text,
  abstract text,
  authors jsonb,
  primary_category text,
  categories jsonb,
  published timestamptz,
  link text,
  source text,
  similarity float8,
  score float8
)
language sql stable
as $$
  with selected as (
    select *
    from public.multi_source_papers_bge_m3 p
    where (filter_sources is null or p.source = any(filter_sources))
      and (filter_published_start is null or p.published >= filter_published_start)
      and (filter_published_end is null or p.published < filter_published_end)
  )
  select
    p.id,
    p.title,
    p.abstract,
    p.authors,
    p.primary_category,
    p.categories,
    p.published,
    p.link,
    p.source,
    0::float8 as similarity,
    ts_rank_cd(
      to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, '')),
      plainto_tsquery('english', query_text)
    ) as score
  from selected p
  where to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.abstract, ''))
        @@ plainto_tsquery('english', query_text)
  order by score desc
  limit match_count;
$$;
