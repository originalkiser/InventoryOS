-- ============================================================
-- Fix helper functions and add missing RLS policies
-- ============================================================

-- ── Bug 3: Fix get_my_company_id() and is_admin() ──────────
-- These were created referencing bare `profiles` (public schema).
-- The app now uses platform.user_profiles.
CREATE OR REPLACE FUNCTION get_my_company_id()
RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT role IN ('admin', 'developer') FROM platform.user_profiles WHERE id = auth.uid()
$$;

-- ── Bug 4: Fix get_product_usage() ─────────────────────────
-- Table moved from public.product_usage → inventory.product_usage
CREATE OR REPLACE FUNCTION get_product_usage(p_company_id uuid)
RETURNS TABLE(
  id                  uuid,
  location_id         uuid,
  product_id          text,
  category            text,
  daily_usage         numeric,
  on_hands            numeric,
  days_of_supply      numeric,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz,
  updated_at          timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    id, location_id, product_id,
    NULLIF(TRIM(COALESCE(category, '')), '') AS category,
    daily_usage, on_hands, days_of_supply,
    updated_by, last_change_source, created_at, updated_at
  FROM inventory.product_usage
  WHERE company_id = p_company_id
  ORDER BY product_id, location_id NULLS LAST;
$$;

-- ── Bug 1: Admin UPDATE policy for platform.user_profiles ──
-- The existing RLS only allows users to update their own row.
-- Admins need to update any user in their company.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'platform'
      AND tablename = 'user_profiles'
      AND policyname = 'Admins can update company users'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins can update company users"
        ON platform.user_profiles
        FOR UPDATE
        USING (
          company_id = get_my_company_id()
          AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'developer')
        )
    $pol$;
  END IF;
END
$$;

-- Admin SELECT policy so admin can read all users in company
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'platform'
      AND tablename = 'user_profiles'
      AND policyname = 'Admins can view company users'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins can view company users"
        ON platform.user_profiles
        FOR SELECT
        USING (company_id = get_my_company_id())
    $pol$;
  END IF;
END
$$;

-- core.user_feature_access — allow admins to upsert/manage all
-- Note: table has no company_id column; scope by checking the target user_id
-- belongs to the same company as the acting admin via platform.user_profiles.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'core'
      AND tablename = 'user_feature_access'
      AND policyname = 'Admins can manage feature access'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins can manage feature access"
        ON core.user_feature_access
        FOR ALL
        USING (
          (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'developer')
          AND EXISTS (
            SELECT 1 FROM platform.user_profiles up
            WHERE up.id = core.user_feature_access.user_id
              AND up.company_id = get_my_company_id()
          )
        )
        WITH CHECK (
          (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'developer')
          AND EXISTS (
            SELECT 1 FROM platform.user_profiles up
            WHERE up.id = core.user_feature_access.user_id
              AND up.company_id = get_my_company_id()
          )
        )
    $pol$;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'core'
      AND tablename = 'user_feature_access'
      AND policyname = 'Users can read own feature access'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Users can read own feature access"
        ON core.user_feature_access
        FOR SELECT
        USING (user_id = auth.uid())
    $pol$;
  END IF;
END
$$;

-- ── Bug 2 + Improvement 9: Outlier schema RLS ──────────────
-- No RLS policies existed for outlier schema tables.

-- outlier.weeks
ALTER TABLE outlier.weeks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'weeks' AND policyname = 'Authenticated users can read weeks'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can read weeks"
        ON outlier.weeks FOR SELECT USING (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'weeks' AND policyname = 'Authenticated users can upsert weeks'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can upsert weeks"
        ON outlier.weeks FOR INSERT WITH CHECK (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'weeks' AND policyname = 'Admins can update weeks'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins can update weeks"
        ON outlier.weeks FOR UPDATE USING (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

-- outlier.report_entries
ALTER TABLE outlier.report_entries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'report_entries' AND policyname = 'Authenticated users can read report_entries'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can read report_entries"
        ON outlier.report_entries FOR SELECT USING (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'report_entries' AND policyname = 'Authenticated users can insert report_entries'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can insert report_entries"
        ON outlier.report_entries FOR INSERT WITH CHECK (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'report_entries' AND policyname = 'Authenticated users can update report_entries'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can update report_entries"
        ON outlier.report_entries FOR UPDATE USING (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

-- outlier.paste_logs
ALTER TABLE outlier.paste_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'paste_logs' AND policyname = 'Authenticated users can read paste_logs'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can read paste_logs"
        ON outlier.paste_logs FOR SELECT USING (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'paste_logs' AND policyname = 'Authenticated users can insert paste_logs'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Authenticated users can insert paste_logs"
        ON outlier.paste_logs FOR INSERT WITH CHECK (auth.role() = 'authenticated')
    $pol$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'outlier' AND tablename = 'paste_logs' AND policyname = 'Admins can update paste_logs'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Admins can update paste_logs"
        ON outlier.paste_logs FOR UPDATE
        USING (
          (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'developer')
        )
    $pol$;
  END IF;
END $$;

-- ── Improvement 11d: submitted_by_override on paste_logs ───
ALTER TABLE outlier.paste_logs
  ADD COLUMN IF NOT EXISTS submitted_by_override uuid REFERENCES auth.users(id) ON DELETE SET NULL;
