"""Tests for Hybrid Search engine, chunking, and Active-Version-Only vector indexing."""

import json
from unittest.mock import MagicMock, patch
import pytest

from models import Group, GroupMembership, Prompt, PromptChunk, PromptVersion, User
from search import (
    _compute_lexical_score,
    chunk_text,
    cosine_similarity,
    hybrid_search_prompts,
    sync_prompt_embeddings,
)


def test_chunk_text_short():
    """Short prompt content should produce exactly one chunk."""
    text = "You are a Python expert specializing in FastAPI and Pydantic."
    chunks = chunk_text(text, chunk_size=1200, overlap=100)
    assert len(chunks) == 1
    assert chunks[0] == text


def test_chunk_text_long_with_overlap():
    """Text longer than chunk_size should produce multiple overlapping chunks."""
    # Create 2,500 words
    words = [f"word{i}" for i in range(2500)]
    long_text = " ".join(words)
    chunks = chunk_text(long_text, chunk_size=1000, overlap=100)
    assert len(chunks) >= 3

    # Check overlap: end of chunk 0 should overlap start of chunk 1
    c0_words = chunks[0].split()
    c1_words = chunks[1].split()
    assert len(c0_words) == 1000
    # Overlap region check
    assert c0_words[-50:] == c1_words[50:100]


def test_cosine_similarity():
    """Verify standard cosine similarity properties."""
    v1 = [1.0, 0.0, 0.0]
    v2 = [1.0, 0.0, 0.0]
    v3 = [0.0, 1.0, 0.0]
    v4 = [-1.0, 0.0, 0.0]

    assert pytest.approx(cosine_similarity(v1, v2)) == 1.0
    assert pytest.approx(cosine_similarity(v1, v3)) == 0.0
    assert pytest.approx(cosine_similarity(v1, v4)) == -1.0
    assert cosine_similarity([], []) == 0.0


def test_lexical_scoring():
    """Verify title, description, and token overlap lexical scores."""
    score_exact = _compute_lexical_score("Code Auditor", "Code Auditor", "Reviews PRs", "Do not allow SQL injection")
    assert score_exact == 1.0

    score_partial = _compute_lexical_score("Code", "Python Code Auditor", "Reviews PRs", "Do not allow SQL injection")
    assert score_partial >= 0.8

    score_desc = _compute_lexical_score("Reviews", "Python Auditor", "Reviews PRs", "Do not allow SQL injection")
    assert score_desc >= 0.6

    score_unrelated = _compute_lexical_score("Unicorn", "Python Code Auditor", "Reviews PRs", "Do not allow SQL injection")
    assert score_unrelated == 0.0


def test_active_version_only_pruning(db, test_users_and_groups):
    """Verify that sync_prompt_embeddings purges old version chunks when a new active version is published."""
    test_user = test_users_and_groups["owner"]
    # Setup group and prompt with unique name
    group = Group(name="Pruning Test Group Unique", created_by=test_user.id)
    db.add(group)
    db.flush()

    prompt = Prompt(group_id=group.id, title="Unit Test Writer", description="Generates pytest fixtures", created_by=test_user.id)
    db.add(prompt)
    db.flush()

    v1 = PromptVersion(prompt_id=prompt.id, version_number=1, content="v1 content", author_id=test_user.id)
    db.add(v1)
    db.flush()
    prompt.current_version_id = v1.id
    db.commit()

    # Mock embed_texts to return a dummy 768-dim vector
    dummy_vec = [0.1] * 768
    with patch("search.get_gemini_api_key", return_value="dummy-key"), \
         patch("search.embed_texts", return_value=[dummy_vec]):
        # Sync v1
        synced = sync_prompt_embeddings(db, prompt, v1)
        assert synced is True
        chunks_v1 = db.query(PromptChunk).filter_by(prompt_id=prompt.id).all()
        assert len(chunks_v1) == 1
        assert chunks_v1[0].version_id == v1.id

        # Now create v2 and sync it
        v2 = PromptVersion(prompt_id=prompt.id, version_number=2, content="v2 improved content", author_id=test_user.id)
        db.add(v2)
        db.flush()
        prompt.current_version_number = 2
        prompt.current_version_id = v2.id
        db.commit()

        synced_v2 = sync_prompt_embeddings(db, prompt, v2)
        assert synced_v2 is True

        # VERIFY: v1's chunks were pruned! Only v2's chunks exist!
        chunks_v2 = db.query(PromptChunk).filter_by(prompt_id=prompt.id).all()
        assert len(chunks_v2) == 1
        assert chunks_v2[0].version_id == v2.id
        assert chunks_v2[0].version_id != v1.id


def test_hybrid_search_scoring_and_rbac(db, test_users_and_groups):
    """Verify hybrid search ranks matching prompts and respects group RBAC boundaries."""
    test_user = test_users_and_groups["owner"]
    # Group A (accessible) with unique name
    grp_a = Group(name="DevOps Unique Alpha", created_by=test_user.id)
    db.add(grp_a)
    db.flush()

    # Group B (inaccessible to this test query) with unique name
    grp_b = Group(name="Confidential HR Unique Beta", created_by="other-user")
    db.add(grp_b)
    db.flush()

    # Prompt 1 in Group A: exact title match
    p1 = Prompt(group_id=grp_a.id, title="Terraform AWS Plan Checker", description="Validates IaC", created_by=test_user.id)
    db.add(p1)
    db.flush()
    v1_1 = PromptVersion(prompt_id=p1.id, version_number=1, content="Check terraform diffs", author_id=test_user.id)
    db.add(v1_1)
    db.flush()
    p1.current_version_id = v1_1.id

    # Prompt 2 in Group A: semantic intent match (different keywords: Cloud Infrastructure Deployment)
    p2 = Prompt(group_id=grp_a.id, title="Cloud Infrastructure Deployment", description="Reviews infrastructure scripts", created_by=test_user.id)
    db.add(p2)
    db.flush()
    v2_1 = PromptVersion(prompt_id=p2.id, version_number=1, content="Automate cloud provisioning", author_id=test_user.id)
    db.add(v2_1)
    db.flush()
    p2.current_version_id = v2_1.id

    # Prompt 3 in Group B: Inaccessible space
    p3 = Prompt(group_id=grp_b.id, title="Terraform Secret Access", description="HR cloud", created_by="other-user")
    db.add(p3)
    db.flush()
    v3_1 = PromptVersion(prompt_id=p3.id, version_number=1, content="Secret credentials", author_id="other-user")
    db.add(v3_1)
    db.flush()
    p3.current_version_id = v3_1.id

    db.commit()

    # Add chunk vectors for p1 and p2
    vec1 = [0.9, 0.1, 0.0] + [0.0] * 765
    vec2 = [0.85, 0.15, 0.0] + [0.0] * 765
    ch1 = PromptChunk(prompt_id=p1.id, version_id=v1_1.id, chunk_index=0, chunk_text="terraform", embedding_json=json.dumps(vec1))
    ch2 = PromptChunk(prompt_id=p2.id, version_id=v2_1.id, chunk_index=0, chunk_text="cloud", embedding_json=json.dumps(vec2))
    db.add_all([ch1, ch2])
    db.commit()

    # Query vector close to vec1 and vec2
    query_vec = [0.95, 0.05, 0.0] + [0.0] * 765
    with patch("search.embed_query", return_value=query_vec):
        results = hybrid_search_prompts(
            db=db,
            query_text="Terraform AWS Plan Checker",
            accessible_group_ids=[grp_a.id],  # ONLY Group A accessible
        )

        assert len(results) >= 1
        found_ids = [r["id"] for r in results]
        # p1 should be rank 1 (both high lexical and high semantic)
        assert found_ids[0] == p1.id
        # p3 in Group B MUST NEVER leak into results
        assert p3.id not in found_ids
