"""Enable Row-Level Security on every public table (Postgres only).

Supabase exposes the public schema over its REST API (PostgREST) to anyone
holding the anon key. RLS with no policies denies that access, while the
backend connects as the table owner and is unaffected.

Revision ID: 0004_enable_rls
Revises: 0003_cross_tier_teams
"""

from alembic import op

revision = "0004_enable_rls"
down_revision = "0003_cross_tier_teams"
branch_labels = None
depends_on = None

_ENABLE = """
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
"""

_DISABLE = _ENABLE.replace("ENABLE ROW", "DISABLE ROW")

# The app never uses Supabase's REST API, so its roles get no table access
# (RLS does not stop TRUNCATE, and a legacy policy allows anon INSERT).
_REVOKE_API_ROLES = """
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
"""


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(_ENABLE)
        op.execute(_REVOKE_API_ROLES)


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(_DISABLE)
