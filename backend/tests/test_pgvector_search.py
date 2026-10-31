"""pgvector semantic search path. Runs only against a real Postgres (CI matrix: postgres)."""

import json
import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from auth import upgrade_schema
from database import Base, normalize_db_url
from models import Group, Prompt, PromptChunk, PromptVersion, User

PG_URL = normalize_db_url(os.getenv("DATABASE_URL", ""))
pytestmark = pytest.mark.skipif(not PG_URL.startswith("postgresql"), reason="needs Postgres")


def test_sql_and_python_semantic_scores_agree():
    import search

    engine = create_engine(PG_URL)
    Base.metadata.create_all(bind=engine)
    upgrade_schema(engine)
    Session = sessionmaker(bind=engine)
    with Session() as db:
        if not search.pgvector_ready(db):
            pytest.skip("pgvector extension not installed")
        u = User(name="V", email=f"vec-{os.getpid()}@x.io")
        db.add(u)
        db.flush()
        g = Group(name=f"vec-{u.id}", created_by=u.id)
        db.add(g)
        db.flush()
        p = Prompt(title="Vec", group_id=g.id, created_by=u.id)
        db.add(p)
        db.flush()
        v = PromptVersion(prompt_id=p.id, version_number=1, content="x", variables_json="[]")
        db.add(v)
        db.flush()
        db.add(PromptChunk(prompt_id=p.id, version_id=v.id, chunk_text="x", embedding_json=json.dumps([1.0, 0.0, 0.0])))
        db.commit()
        search.backfill_vector_column(db, p.id)

        q = [0.6, 0.8, 0.0]
        sql = search._semantic_scores_sql(db, q, [p.id])
        py = search._semantic_scores_python(db, q, [p.id])
        assert sql[p.id] == pytest.approx(py[p.id], abs=1e-6) == pytest.approx(0.6, abs=1e-6)
        # Mismatched dimensions are ignored rather than erroring.
        assert search._semantic_scores_sql(db, [1.0, 0.0], [p.id]) == {}

        db.execute(text("DELETE FROM prompt_chunks WHERE prompt_id = :p"), {"p": p.id})
        db.query(PromptVersion).filter_by(prompt_id=p.id).delete()
        db.query(Prompt).filter_by(id=p.id).delete()
        db.query(Group).filter_by(id=g.id).delete()
        db.query(User).filter_by(id=u.id).delete()
        db.commit()
