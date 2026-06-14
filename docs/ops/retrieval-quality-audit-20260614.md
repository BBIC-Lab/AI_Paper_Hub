# 检索质量排查快照（2026-06-14）

## 结论摘要

- `origin/main` 2026-06-13 的本地 embedding+reranker 日报，与 `BBIC-Lab/AI_Daily_Paper_Reader` 2026-06-12 的远端 embedding+无 reranker 日报相比，推荐集合明显不同。
- 同日对比中，`origin/main` 2026-06-12 与公共仓库 2026-06-12 的推荐交集为 0/10。
- 主要风险不在 LLM 精读本身，而在候选进入 Step 4 前已经偏移，以及 Step 5 使用 `selection_score = LLM + 2 * rerank_score` 把 per-query 归一化 rerank 分数放大。
- 代码已改为：默认保留 Supabase/远端向量召回质量基线；rerank 改为 query-local；selection 中 rerank 仅按 top-rank 门控做小幅加分。

## 私有 origin/main 2026-06-13 最终推荐

|阶段/区域|名次|ID|分数|rerank|标题|
|---|---:|---|---:|---:|---|
|deep_dive|1|`biorxiv-10-64898-2026-01-07-698228-v2`|9.0|0.986|Successful single-session neural self-regulation through neurofeedback va...|
|deep_dive|2|`2606.11432v1`|9.0|0.939|Additive Noise, Shift Recovery, and Signed Signals in the Cumulative Dist...|
|deep_dive|3|`2606.09762v1`|8.0|0.977|Preserving Plasticity in Continual Learning via Dynamical Isometry|
|deep_dive|4|`2606.09640v1`|8.0|0.612|Physics-Aware Sparse Learning and Selective Online Adaptation for Euler-L...|
|deep_dive|5|`2606.11363v1`|8.0|0.996|NSVQ: Mitigating Codebook Collapse by Stabilizing Encoder Drift in Vector...|
|quick_skim|1|`2606.09667v1`|7.0|0.962|Cross-Modal Masking for Robust Silent Speech Synthesis Using sEMG and Lip...|
|quick_skim|2|`2606.11831v1`|7.0|0.994|From Uniform to Learned Graph Priors: Diffusion for Structure Discovery|
|quick_skim|3|`2606.11962v1`|7.0|0.888|Composite likelihood inference of fractional Gaussian processes with sequ...|
|quick_skim|4|`2606.09355v1`|7.0|0.944|MosaicIMU: Composing Carrier Experts for Generalizable Neural Inertial Od...|
|quick_skim|5|`2606.10212v1`|7.0|0.754|Intrinsic Footpoint-invariant Riemannian Cross-covariance|
|quick_skim|6|`2606.10829v1`|7.0|0.930|Attention-Discounted Adaptive Sampler for Masked Diffusion Language Models|
|quick_skim|7|`2606.09725v1`|7.0|0.649|Disentanglement with Holographic Reduced Representations|
|quick_skim|8|`2606.11553v1`|7.0|0.619|APEX: A Network-Native Time-Series Foundation Model for Forecasting and A...|
|quick_skim|9|`2606.11660v1`|7.0|0.921|Bergson: An Open Source Library for Data Attribution|
|quick_skim|10|`2606.09508v1`|6.0|0.996|From Rigid to Dynamic: Entropy-Guided Adaptive Inference for Long-Context...|

## 公共 BBIC-Lab/AI_Daily_Paper_Reader 2026-06-12 最终推荐

|阶段/区域|名次|ID|分数|rerank|标题|
|---|---:|---|---:|---:|---|
|deep_dive|1|`2606.10530v1`|10.0|-|Machine Learning Methods for Studying Latent Neural Activity Dynamics|
|deep_dive|2|`2606.08594v1`|9.0|-|How Much Capacity Does EEG Denoising Need? Ultra-Compact Networks reveal ...|
|deep_dive|3|`2606.08601v1`|9.0|-|InA-Probe: Instruction-Aware Active Probing for Time Series Forecasting w...|
|deep_dive|4|`2606.08630v1`|9.0|-|Tyan-WP: A Wind Power Foundation Model for Ultra-Short-Term Probabilistic...|
|deep_dive|5|`2606.08691v1`|9.0|-|Hierarchical Projection for Adaptive Knowledge Transfer|
|quick_skim|1|`2606.08578v1`|8.0|-|Lost in the Non-convex Loss Landscape: How to Fine-tune the Large Time Se...|
|quick_skim|2|`2606.08520v1`|7.0|-|Two Bridges, One Pathway: From VLMs to Generalizable VLAs with Embodied T...|
|quick_skim|3|`2606.08804v1`|8.0|-|Q-Delta: Beyond Key-Value Associative State Evolution|
|quick_skim|4|`2606.08935v1`|8.0|-|PAI: Preserving Amplitude Information in Representation-Based Time-Series...|
|quick_skim|5|`2606.08978v1`|8.0|-|Heterophily-Aware Adaptive Knowledge Distillation for Hypergraph Neural N...|

## 同日 2026-06-12 重合度

- 私有 `origin/main` 2026-06-12 推荐数：15
- 公共 `BBIC-Lab/AI_Daily_Paper_Reader` 2026-06-12 推荐数：10
- 交集：0

## rerank 放大效应诊断（私有 2026-06-13）

|区域|ID|LLM|旧selection|rerank rank|门控后约值|标题|
|---|---|---:|---:|---:|---:|---|
|deep_dive|`biorxiv-10-64898-2026-01-07-698228-v2`|9.0|10.97|33|9.00|Successful single-session neural self-regulation through neur...|
|deep_dive|`2606.11432v1`|9.0|9.00|72|9.00|Additive Noise, Shift Recovery, and Signed Signals in the Cum...|
|deep_dive|`2606.09762v1`|8.0|10.45|42|8.50|Preserving Plasticity in Continual Learning via Dynamical Iso...|
|deep_dive|`2606.09640v1`|8.0|9.22|75|8.00|Physics-Aware Sparse Learning and Selective Online Adaptation...|
|deep_dive|`2606.11363v1`|8.0|8.00|22|8.00|NSVQ: Mitigating Codebook Collapse by Stabilizing Encoder Dri...|
|quick_skim|`2606.09667v1`|7.0|8.92|53|7.00|Cross-Modal Masking for Robust Silent Speech Synthesis Using ...|
|quick_skim|`2606.11831v1`|7.0|8.93|26|7.10|From Uniform to Learned Graph Priors: Diffusion for Structure...|
|quick_skim|`2606.11962v1`|7.0|8.78|34|7.00|Composite likelihood inference of fractional Gaussian process...|
|quick_skim|`2606.09355v1`|7.0|8.61|60|7.00|MosaicIMU: Composing Carrier Experts for Generalizable Neural...|
|quick_skim|`2606.10212v1`|7.0|8.51|58|7.00|Intrinsic Footpoint-invariant Riemannian Cross-covariance|
|quick_skim|`2606.10829v1`|7.0|8.44|69|7.00|Attention-Discounted Adaptive Sampler for Masked Diffusion La...|
|quick_skim|`2606.09725v1`|7.0|8.30|61|7.00|Disentanglement with Holographic Reduced Representations|
|quick_skim|`2606.11553v1`|7.0|8.24|72|7.00|APEX: A Network-Native Time-Series Foundation Model for Forec...|
|quick_skim|`2606.11660v1`|7.0|8.22|74|7.00|Bergson: An Open Source Library for Data Attribution|
|quick_skim|`2606.09508v1`|6.0|7.99|11|6.40|From Rigid to Dynamic: Entropy-Guided Adaptive Inference for ...|

## 已定位的代码触发点

- `.github/workflows/daily-paper-reader.yml` 原先固定 `DPR_DISABLE_SUPABASE_VECTOR=true`，私有流水线默认绕过远端/Supabase 向量召回质量基线。
- `src/3.rank_papers.py` 原先让每条 rerank query 重排整条 track 的全局候选池，宽泛 query 会给不相关论文一次“碰高分”的机会。
- `src/5.select_papers.py` 原先直接把 per-query 归一化 rerank 分数乘 2 加到 LLM 分，导致 6–7 分论文可被抬到接近 8–9 分。
