-- ============================================================
-- bge-m3 1024 维 arXiv 影子表 HNSW 索引
-- ============================================================
-- 仅在 arxiv_papers_bge_m3 近 6 个月窗口 upsert 完成后执行。
-- 导入前创建 HNSW 会显著拖慢批量写入。
-- bioRxiv 已从 bge-m3 影子库移除，不再创建 biorxiv HNSW。
-- ============================================================

create index if not exists arxiv_papers_bge_m3_embedding_hnsw_idx
  on public.arxiv_papers_bge_m3
  using hnsw (embedding vector_cosine_ops);
