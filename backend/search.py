"""Hybrid Search engine for PromptHold combining lexical/fuzzy matching with Google Gemini semantic vector embeddings.

Features:
- Active-Version-Only indexing (deletes old revision vectors on publish to preserve storage).
- Batch chunking with sentence/word overlap for prompts exceeding context thresholds.
- Reciprocal Rank Fusion (RRF) blending keyword/fuzzy relevance and cosine vector similarity.
- Resilient fallback to lexical/fuzzy matching when GEMINI_API_KEY is not configured or offline.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from typing import Any

import httpx
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models import Group, Prompt, PromptChunk, PromptVersion

logger = logging.getLogger("prompthold.search")

# In-memory query embedding cache to save API quota and provide 0ms latency for repeated queries
_QUERY_EMBEDDING_CACHE: dict[str, list[float]] = {}
_MAX_QUERY_CACHE_SIZE = 256


def get_gemini_api_key() -> str | None:
    """Return the configured Gemini API key, if available."""
    raw = (
        os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
        or os.getenv("GOOGLE_GENAI_API_KEY")
        or ""
    ).strip().strip("'\"")
    if not raw or any(placeholder in raw for placeholder in ["[YOUR-KEY]", "YOUR_KEY", "example"]):
        return None
    return raw


def chunk_text(text: str, chunk_size: int = 1200, overlap: int = 100) -> list[str]:
    """Split text into manageable chunks respecting word boundaries with overlap."""
    clean_text = text.strip()
    if not clean_text:
        return []
    words = clean_text.split()
    if len(words) <= chunk_size:
        return [clean_text]

    chunks: list[str] = []
    start = 0
    stride = max(1, chunk_size - overlap)
    while start < len(words):
        end = min(len(words), start + chunk_size)
        chunk = " ".join(words[start:end])
        if chunk:
            chunks.append(chunk)
        if end >= len(words):
            break
        start += stride
    return chunks


def cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """Compute cosine similarity between two float vectors in pure Python."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = 0.0
    norm1 = 0.0
    norm2 = 0.0
    for a, b in zip(v1, v2):
        dot += a * b
        norm1 += a * a
        norm2 += b * b
    if norm1 <= 0.0 or norm2 <= 0.0:
        return 0.0
    return dot / (math.sqrt(norm1) * math.sqrt(norm2))


def embed_texts(texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
    """Generate 768-dimensional vector embeddings for a list of texts using Google Gemini API."""
    api_key = get_gemini_api_key()
    if not api_key or not texts:
        return []

    # Prepare batch request payload
    requests = []
    for t in texts:
        safe_text = t[:20_000]  # Avoid exceeding maximum payload limits
        requests.append({
            "model": "models/text-embedding-004",
            "content": {"parts": [{"text": safe_text}]},
            "taskType": task_type,
        })

    url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key={api_key}"
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(url, json={"requests": requests}, headers=headers)
            if resp.status_code != 200:
                logger.warning("Gemini batch embedding API returned %s: %s", resp.status_code, resp.text[:200])
                return []
            data = resp.json()
            embeddings_data = data.get("embeddings", [])
            return [item.get("values", []) for item in embeddings_data if "values" in item]
    except Exception as exc:
        logger.warning("Failed to generate Gemini embeddings: %s", exc)
        return []


def embed_query(query: str) -> list[float] | None:
    """Generate a 768-dimensional vector embedding for a search query with in-memory caching."""
    clean_q = query.strip()[:500]
    if not clean_q:
        return None
    if clean_q in _QUERY_EMBEDDING_CACHE:
        return _QUERY_EMBEDDING_CACHE[clean_q]

    results = embed_texts([clean_q], task_type="RETRIEVAL_QUERY")
    if results and results[0]:
        emb = results[0]
        if len(_QUERY_EMBEDDING_CACHE) >= _MAX_QUERY_CACHE_SIZE:
            # Evict oldest entry
            _QUERY_EMBEDDING_CACHE.pop(next(iter(_QUERY_EMBEDDING_CACHE)))
        _QUERY_EMBEDDING_CACHE[clean_q] = emb
        return emb
    return None


def sync_prompt_embeddings(db: Session, prompt: Prompt, version: PromptVersion) -> bool:
    """Index the active prompt version for semantic search, enforcing Active-Version-Only pruning.

    Any existing chunk vectors for this prompt are removed before inserting the new active version's
    embeddings, guaranteeing that each prompt only ever consumes one vector footprint.
    """
    try:
        # 1. Enforce Active-Version-Only Rule: Delete any existing chunks for this prompt
        db.query(PromptChunk).filter(PromptChunk.prompt_id == prompt.id).delete()
        db.flush()

        api_key = get_gemini_api_key()
        if not api_key:
            # When no API key is provided, search falls back cleanly to lexical/fuzzy matching
            db.commit()
            return False

        # 2. Build full text context
        header = f"Title: {prompt.title}\nDescription: {prompt.description or ''}\n\nInstructions and Content:\n"
        full_text = header + (version.content or "")

        # 3. Chunk text (single chunk for standard prompts, multi-chunk with overlap for long ones)
        chunks = chunk_text(full_text, chunk_size=1200, overlap=100)
        if not chunks:
            db.commit()
            return False

        # 4. Generate batch embeddings in a single API call
        embeddings = embed_texts(chunks, task_type="RETRIEVAL_DOCUMENT")
        if not embeddings or len(embeddings) != len(chunks):
            logger.warning("Embeddings count mismatch or generation failure for prompt %s", prompt.id)
            db.commit()
            return False

        # 5. Persist chunks
        for idx, (chunk_text_item, emb_values) in enumerate(zip(chunks, embeddings)):
            chunk_record = PromptChunk(
                prompt_id=prompt.id,
                version_id=version.id,
                chunk_index=idx,
                chunk_text=chunk_text_item,
                embedding_json=json.dumps(emb_values),
            )
            db.add(chunk_record)

        db.commit()
        return True
    except Exception as exc:
        logger.warning("Error syncing prompt embeddings for %s: %s", prompt.id, exc)
        try:
            db.rollback()
        except Exception:
            pass
        return False


def _compute_lexical_score(query: str, title: str, description: str, content: str) -> float:
    """Compute lexical match score (0.0 to 1.0) using token overlap and substring matching."""
    q_lower = query.lower().strip()
    if not q_lower:
        return 0.0

    t_lower = (title or "").lower()
    d_lower = (description or "").lower()
    c_lower = (content or "").lower()

    # Exact phrase matches
    if q_lower == t_lower:
        return 1.0
    if q_lower in t_lower:
        return 0.85
    if q_lower in d_lower:
        return 0.65
    if q_lower in c_lower:
        return 0.50

    # Token overlap scoring
    tokens = [tok for tok in re.split(r"\W+", q_lower) if len(tok) >= 2]
    if not tokens:
        return 0.0

    score = 0.0
    matched_title = sum(1 for tok in tokens if tok in t_lower)
    matched_desc = sum(1 for tok in tokens if tok in d_lower)
    matched_content = sum(1 for tok in tokens if tok in c_lower)

    score += (matched_title / len(tokens)) * 0.5
    score += (matched_desc / len(tokens)) * 0.3
    score += (matched_content / len(tokens)) * 0.2

    return min(1.0, score)


def hybrid_search_prompts(
    db: Session,
    query_text: str,
    accessible_group_ids: list[str],
    group_id_filter: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Execute Hybrid Search combining lexical/fuzzy scoring with semantic vector similarity via RRF.

    Returns ranked list of dicts with prompt metadata and match confidence scores.
    """
    clean_q = query_text.strip()
    if not clean_q or not accessible_group_ids:
        return []

    # 1. Fetch active version rows for all accessible prompts
    ver_count_subq = (
        db.query(
            PromptVersion.prompt_id.label("p_id"),
            func.count(PromptVersion.id).label("v_count"),
        )
        .group_by(PromptVersion.prompt_id)
        .subquery()
    )

    base_query = (
        db.query(Prompt, Group, PromptVersion, func.coalesce(ver_count_subq.c.v_count, 1))
        .join(Group, Prompt.group_id == Group.id)
        .join(
            PromptVersion,
            (PromptVersion.id == Prompt.current_version_id)
            | (
                Prompt.current_version_id.is_(None)
                & (PromptVersion.prompt_id == Prompt.id)
                & (PromptVersion.version_number == Prompt.current_version_number)
            ),
        )
        .outerjoin(ver_count_subq, ver_count_subq.c.p_id == Prompt.id)
        .filter(Prompt.group_id.in_(accessible_group_ids), Prompt.is_archived.is_(False))
    )

    if group_id_filter:
        base_query = base_query.filter(Prompt.group_id == group_id_filter)

    candidates = base_query.all()
    if not candidates:
        return []

    # 2. Compute Lexical Scores
    lexical_scored: list[tuple[str, float]] = []
    candidates_by_id: dict[str, tuple[Prompt, Group, PromptVersion, int]] = {}
    for prompt, group, version, v_count in candidates:
        candidates_by_id[prompt.id] = (prompt, group, version, int(v_count or 1))
        score = _compute_lexical_score(clean_q, prompt.title, prompt.description, version.content)
        if score > 0.05:
            lexical_scored.append((prompt.id, score))

    lexical_scored.sort(key=lambda x: x[1], reverse=True)
    lexical_ranks: dict[str, int] = {p_id: rank for rank, (p_id, _) in enumerate(lexical_scored, start=1)}

    # 3. Compute Semantic Scores (if Gemini query embedding available and chunks exist)
    semantic_ranks: dict[str, int] = {}
    semantic_scores: dict[str, float] = {}
    query_vector = embed_query(clean_q)

    if query_vector:
        prompt_ids = list(candidates_by_id.keys())
        chunks = db.query(PromptChunk).filter(PromptChunk.prompt_id.in_(prompt_ids)).all()
        # Group chunks by prompt_id, finding maximum similarity per prompt
        prompt_max_sim: dict[str, float] = {}
        for ch in chunks:
            try:
                emb = json.loads(ch.embedding_json)
                sim = cosine_similarity(query_vector, emb)
                if sim > prompt_max_sim.get(ch.prompt_id, -1.0):
                    prompt_max_sim[ch.prompt_id] = sim
            except Exception:
                continue

        # Keep candidates with meaningful semantic similarity (>0.35)
        semantic_scored = [(p_id, sim) for p_id, sim in prompt_max_sim.items() if sim > 0.35]
        semantic_scored.sort(key=lambda x: x[1], reverse=True)
        semantic_ranks = {p_id: rank for rank, (p_id, _) in enumerate(semantic_scored, start=1)}
        semantic_scores = {p_id: sim for p_id, sim in semantic_scored}

    # 4. Reciprocal Rank Fusion (RRF)
    # RRF formula: 1 / (60 + rank_lexical) + 1 / (60 + rank_semantic)
    all_matched_ids = set(lexical_ranks.keys()) | set(semantic_ranks.keys())
    if not all_matched_ids:
        # If no fuzzy or semantic threshold hit, fallback to simple case-insensitive substring filter
        q_lower = clean_q.lower()
        fallback_ids = [
            p.id for p, _, v, _ in candidates
            if q_lower in p.title.lower() or q_lower in (p.description or "").lower() or q_lower in v.content.lower()
        ]
        all_matched_ids = set(fallback_ids)

    fused_scores: list[tuple[str, float, float]] = []
    k_constant = 60.0
    for p_id in all_matched_ids:
        lex_rank = lexical_ranks.get(p_id)
        sem_rank = semantic_ranks.get(p_id)
        rrf_score = 0.0
        if lex_rank is not None:
            rrf_score += 1.0 / (k_constant + lex_rank)
        if sem_rank is not None:
            rrf_score += 1.0 / (k_constant + sem_rank)

        # Compute raw confidence percentage for display (0.0 to 1.0)
        sem_sim = semantic_scores.get(p_id, 0.0)
        lex_sim = next((score for id_, score in lexical_scored if id_ == p_id), 0.0)
        confidence = max(sem_sim, lex_sim) if sem_sim > 0 and lex_sim > 0 else (sem_sim or lex_sim)

        fused_scores.append((p_id, rrf_score, confidence))

    fused_scores.sort(key=lambda x: x[1], reverse=True)

    # 5. Build results preserving PromptHold schema contract
    from permissions import group_display_name

    results: list[dict[str, Any]] = []
    for p_id, rrf_val, confidence in fused_scores[:limit]:
        if p_id not in candidates_by_id:
            continue
        prompt, group, version, v_count = candidates_by_id[p_id]
        results.append({
            "id": prompt.id,
            "group_id": prompt.group_id,
            "group_name": group_display_name(group),
            "title": prompt.title,
            "description": prompt.description,
            "current_version_number": prompt.current_version_number,
            "current_version_id": version.id,
            "updated_at": prompt.updated_at.isoformat() + "Z",
            "content": version.content,
            "variables": json.loads(version.variables_json) if version.variables_json else [],
            "version_count": v_count,
            "match_confidence": round(confidence, 2),
            "hybrid_rank_score": round(rrf_val, 4),
        })

    return results
