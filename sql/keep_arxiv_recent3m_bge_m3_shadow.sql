-- Keep only arXiv recent-3-month data in bge-m3 shadow tables.
-- Cutoff date is based on current date 2026-06-14: keep published >= 2026-03-14 UTC.
-- This is idempotent. It does not drop tables/RPCs/views.

select 'before_arxiv_total' as label, count(*) as rows
from public.arxiv_papers_bge_m3;

select 'before_arxiv_recent3m' as label, count(*) as rows
from public.arxiv_papers_bge_m3
where published >= timestamptz '2026-03-14 00:00:00+00';

select 'before_biorxiv_total' as label, count(*) as rows
from public.biorxiv_papers_bge_m3;

-- Remove non-arxiv source data from the shadow DB.
truncate table public.biorxiv_papers_bge_m3;

-- Enforce recent-3-month arxiv window.
delete from public.arxiv_papers_bge_m3
where published is null
   or published < timestamptz '2026-03-14 00:00:00+00';

analyze public.biorxiv_papers_bge_m3;
analyze public.arxiv_papers_bge_m3;

select 'after_arxiv_total' as label, count(*) as rows
from public.arxiv_papers_bge_m3;

select 'after_biorxiv_total' as label, count(*) as rows
from public.biorxiv_papers_bge_m3;
