-- ==============================================================================
-- PromptFolders PostgreSQL Row-Level Security (RLS) Policies
-- ==============================================================================
-- These policies provide defense-in-depth on Supabase and Neon PostgreSQL.
-- Even if an application-layer authorization check is somehow bypassed or a
-- raw query is issued, the database engine itself enforces multi-tenant
-- and personal-space isolation.
--
-- How to apply:
--   Execute this script in the Supabase SQL Editor or via psql on Neon:
--   psql "$DATABASE_URL" -f rls_policies.sql
-- ==============================================================================

-- 1. Enable RLS on core tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 2. Helper functions to inspect the current authenticated context
-- The application sets this per-transaction using:
--   SET LOCAL app.current_user_id = '<user_uuid>';
--   SET LOCAL app.is_admin = 'true'; -- if workspace admin
CREATE OR REPLACE FUNCTION app_user_id() RETURNS TEXT AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS BOOLEAN AS $$
    SELECT COALESCE(current_setting('app.is_admin', true) = 'true', false);
$$ LANGUAGE SQL STABLE;

-- ------------------------------------------------------------------------------
-- API Keys Table Policies
-- Strictly isolated to the owning user
-- ------------------------------------------------------------------------------
CREATE POLICY api_keys_owner_all ON api_keys
    FOR ALL
    USING (
        user_id = app_user_id() OR app_is_admin()
    )
    WITH CHECK (
        user_id = app_user_id() OR app_is_admin()
    );

-- ------------------------------------------------------------------------------
-- Auth Sessions Table Policies
-- Strictly isolated to the owning user
-- ------------------------------------------------------------------------------
CREATE POLICY auth_sessions_owner_all ON auth_sessions
    FOR ALL
    USING (
        user_id = app_user_id() OR app_is_admin()
    )
    WITH CHECK (
        user_id = app_user_id() OR app_is_admin()
    );

-- ------------------------------------------------------------------------------
-- Groups Table Policies
-- Personal spaces are strictly accessible only by personal_owner_id
-- Team groups are accessible if user has a membership or is workspace admin
-- ------------------------------------------------------------------------------
CREATE POLICY groups_select_policy ON groups
    FOR SELECT
    USING (
        app_is_admin()
        OR (personal_owner_id IS NOT NULL AND personal_owner_id = app_user_id())
        OR (id IN (
            SELECT group_id FROM group_memberships WHERE user_id = app_user_id()
        ))
    );

CREATE POLICY groups_insert_policy ON groups
    FOR INSERT
    WITH CHECK (
        app_is_admin()
        OR (personal_owner_id IS NOT NULL AND personal_owner_id = app_user_id())
        OR created_by = app_user_id()
    );

-- ------------------------------------------------------------------------------
-- Prompts Table Policies
-- Prompts can only be viewed or modified by members of the prompt's group
-- ------------------------------------------------------------------------------
CREATE POLICY prompts_select_policy ON prompts
    FOR SELECT
    USING (
        app_is_admin()
        OR group_id IN (
            SELECT id FROM groups WHERE personal_owner_id = app_user_id()
            UNION
            SELECT group_id FROM group_memberships WHERE user_id = app_user_id()
        )
    );

CREATE POLICY prompts_write_policy ON prompts
    FOR ALL
    USING (
        app_is_admin()
        OR group_id IN (
            SELECT id FROM groups WHERE personal_owner_id = app_user_id()
            UNION
            SELECT group_id FROM group_memberships 
            WHERE user_id = app_user_id() AND role IN ('GROUP_MANAGER', 'MEMBER')
        )
    );

-- ------------------------------------------------------------------------------
-- Prompt Versions Table Policies
-- Inherits prompt group membership visibility
-- ------------------------------------------------------------------------------
CREATE POLICY prompt_versions_select_policy ON prompt_versions
    FOR SELECT
    USING (
        app_is_admin()
        OR prompt_id IN (
            SELECT id FROM prompts WHERE group_id IN (
                SELECT id FROM groups WHERE personal_owner_id = app_user_id()
                UNION
                SELECT group_id FROM group_memberships WHERE user_id = app_user_id()
            )
        )
    );

-- ------------------------------------------------------------------------------
-- Audit Logs Table Policies
-- Append-only for all authenticated actors; readable by workspace admins
-- ------------------------------------------------------------------------------
CREATE POLICY audit_logs_insert_policy ON audit_logs
    FOR INSERT
    WITH CHECK (true);

CREATE POLICY audit_logs_select_policy ON audit_logs
    FOR SELECT
    USING (
        app_is_admin() OR user_id = app_user_id()
    );
