-- bge-m3 shadow cleanup for Supabase Free storage pressure.
-- Backup already saved locally before running this SQL:
-- archive/bge_m3_rebuild/db_backups/biorxiv_papers_bge_m3_before_delete_20260614T103009Z.jsonl.gz

-- 1) Confirm current logical counts.
select 'before_biorxiv' as label, count(*) as rows
from public.biorxiv_papers_bge_m3;

select 'before_arxiv_old_than_3y' as label, count(*) as rows
from public.arxiv_papers_bge_m3
where published < timestamptz '2023-06-14 00:00:00+00';

-- 2) Free biorxiv shadow storage immediately while keeping table/RPC/view schema.
truncate table public.biorxiv_papers_bge_m3;

-- 3) Enforce arxiv recent-3-year window. Current imported arxiv rows are expected to be 0 here,
-- but keep this delete for future reruns with older data.
delete from public.arxiv_papers_bge_m3
where published < timestamptz '2023-06-14 00:00:00+00';

analyze public.biorxiv_papers_bge_m3;
analyze public.arxiv_papers_bge_m3;

-- 4) Verify after cleanup.
select 'after_biorxiv' as label, count(*) as rows
from public.biorxiv_papers_bge_m3;

select 'after_arxiv_total' as label, count(*) as rows
from public.arxiv_papers_bge_m3;

select
  c.relname as relation,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('biorxiv_papers_bge_m3', 'arxiv_papers_bge_m3')
order by pg_total_relation_size(c.oid) desc;
