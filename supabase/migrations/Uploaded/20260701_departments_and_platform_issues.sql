-- ============================================================
-- Departments, user memberships, and unified platform.issues
-- Migrates inventory.issues → platform.issues with department_id
-- ============================================================

-- ============================================================
-- 1. platform.departments
-- ============================================================
CREATE TABLE platform.departments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  name          text        NOT NULL,
  slug          text        NOT NULL,
  sort_order    int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (company_id, slug)
);

ALTER TABLE platform.departments ENABLE ROW LEVEL SECURITY;

-- Seed 6 departments for every existing company
INSERT INTO platform.departments (company_id, name, slug, sort_order)
SELECT DISTINCT p.company_id, dept.name, dept.slug, dept.sort_order
FROM platform.user_profiles p
CROSS JOIN (VALUES
  ('Inventory',          'inventory',          1),
  ('Operations',         'operations',         2),
  ('Marketing',          'marketing',          3),
  ('Finance',            'finance',            4),
  ('Accounting',         'accounting',         5),
  ('Project Management', 'project_management', 6)
) AS dept(name, slug, sort_order)
WHERE p.deleted_at IS NULL
ON CONFLICT (company_id, slug) DO NOTHING;

-- ============================================================
-- 2. platform.user_department_memberships
-- ============================================================
CREATE TABLE platform.user_department_memberships (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  department_id uuid        NOT NULL REFERENCES platform.departments(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (user_id, department_id)
);

CREATE INDEX ON platform.user_department_memberships (user_id);
CREATE INDEX ON platform.user_department_memberships (department_id);

ALTER TABLE platform.user_department_memberships ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. platform.issues
-- ============================================================
CREATE TABLE platform.issues (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL,
  department_id           uuid        NOT NULL REFERENCES platform.departments(id) ON DELETE RESTRICT,
  location_id             uuid,       -- logical FK → inventory.locations(id)
  category_id             uuid,       -- logical FK → inventory.issue_categories(id)
  status_id               uuid,       -- logical FK → inventory.issue_statuses(id)
  title                   text,
  issue_notes             text,
  resolution_notes        text,
  vendor                  text,
  assignee                text,
  helpful_links           text[]      NOT NULL DEFAULT '{}',
  start_date              date,
  target_resolution_date  date,
  resolved_date           date,
  visibility              text        NOT NULL DEFAULT 'department'
                            CHECK (visibility IN ('private', 'department', 'attendees', 'specific_users')),
  deleted_at              timestamptz,
  created_by              uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON platform.issues (company_id);
CREATE INDEX ON platform.issues (department_id);
CREATE INDEX ON platform.issues (status_id);
CREATE INDEX ON platform.issues (deleted_at);

ALTER TABLE platform.issues ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Visibility support tables
-- ============================================================
CREATE TABLE platform.issue_shares (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES platform.issues(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  UNIQUE (issue_id, user_id)
);

ALTER TABLE platform.issue_shares ENABLE ROW LEVEL SECURITY;

CREATE TABLE platform.issue_participants (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES platform.issues(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  UNIQUE (issue_id, user_id)
);

ALTER TABLE platform.issue_participants ENABLE ROW LEVEL SECURITY;

CREATE TABLE platform.issue_department_exclusions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES platform.issues(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  UNIQUE (issue_id, user_id)
);

ALTER TABLE platform.issue_department_exclusions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. Migrate inventory.issues → platform.issues
--    department_id = the Inventory department for each company
-- ============================================================
INSERT INTO platform.issues (
  id, company_id, department_id,
  location_id, category_id, status_id,
  title, issue_notes, resolution_notes, vendor, assignee,
  helpful_links, start_date, target_resolution_date, resolved_date,
  visibility, deleted_at, created_by, created_at, updated_at
)
SELECT
  i.id,
  i.company_id,
  d.id,
  i.location_id,
  i.category_id,
  i.status_id,
  i.title,
  NULL,
  i.resolution_notes,
  NULL,
  i.assignee,
  COALESCE(i.helpful_links, '{}'),
  i.start_date,
  i.target_resolution_date,
  i.resolved_date,
  'department',
  i.deleted_at,
  i.created_by,
  i.created_at,
  i.updated_at
FROM inventory.issues i
JOIN platform.departments d
  ON d.company_id = i.company_id AND d.slug = 'inventory';

-- ============================================================
-- 6. Drop old inventory tables (pending migrations used IF EXISTS)
-- ============================================================
DROP TABLE IF EXISTS inventory.issue_department_exclusions CASCADE;
DROP TABLE IF EXISTS inventory.issue_participants CASCADE;
DROP TABLE IF EXISTS inventory.issue_shares CASCADE;
DROP TABLE IF EXISTS inventory.issues CASCADE;

-- ============================================================
-- 7. RLS policies
-- ============================================================

-- departments: any company member can read; admins manage
CREATE POLICY "dept_company_member_select" ON platform.departments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.departments.company_id
        AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "dept_admin_all" ON platform.departments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.departments.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
  );

-- memberships: own row always visible; admins see all in company
CREATE POLICY "membership_self_select" ON platform.user_department_memberships
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.user_department_memberships.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "membership_admin_all" ON platform.user_department_memberships
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.user_department_memberships.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
  );

-- issues SELECT: department member OR visibility grant OR admin/author
CREATE POLICY "issues_select" ON platform.issues
  FOR SELECT USING (
    deleted_at IS NULL
    AND (
      -- admin/developer sees all in their company
      EXISTS (
        SELECT 1 FROM platform.user_profiles p
        WHERE p.id = auth.uid()
          AND p.company_id = platform.issues.company_id
          AND p.role IN ('admin', 'developer')
          AND p.deleted_at IS NULL
      )
      -- author always sees own
      OR created_by = auth.uid()
      -- department member (and not excluded)
      OR (
        visibility = 'department'
        AND EXISTS (
          SELECT 1 FROM platform.user_department_memberships m
          WHERE m.user_id = auth.uid()
            AND m.department_id = platform.issues.department_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM platform.issue_department_exclusions e
          WHERE e.issue_id = platform.issues.id AND e.user_id = auth.uid()
        )
      )
      -- specific users list
      OR (
        visibility = 'specific_users'
        AND EXISTS (
          SELECT 1 FROM platform.issue_shares s
          WHERE s.issue_id = platform.issues.id AND s.user_id = auth.uid()
        )
      )
      -- attendees
      OR (
        visibility = 'attendees'
        AND EXISTS (
          SELECT 1 FROM platform.issue_participants ip
          WHERE ip.issue_id = platform.issues.id AND ip.user_id = auth.uid()
        )
      )
    )
  );

-- issues INSERT: must be a department member to create in that department
CREATE POLICY "issues_insert" ON platform.issues
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM platform.user_profiles
      WHERE id = auth.uid() AND deleted_at IS NULL
    )
    AND (
      EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = platform.issues.department_id
      )
      OR EXISTS (
        SELECT 1 FROM platform.user_profiles p
        WHERE p.id = auth.uid()
          AND p.company_id = platform.issues.company_id
          AND p.role IN ('admin', 'developer')
          AND p.deleted_at IS NULL
      )
    )
  );

-- issues UPDATE/DELETE: author or admin
CREATE POLICY "issues_update" ON platform.issues
  FOR UPDATE USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.issues.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "issues_delete" ON platform.issues
  FOR DELETE USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.issues.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
  );

-- issue_shares: read if in same company; write if author or admin
CREATE POLICY "issue_shares_select" ON platform.issue_shares
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      JOIN platform.user_profiles p ON p.company_id = i.company_id
      WHERE i.id = platform.issue_shares.issue_id
        AND p.id = auth.uid() AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "issue_shares_all" ON platform.issue_shares
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      WHERE i.id = platform.issue_shares.issue_id
        AND (
          i.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM platform.user_profiles p
            WHERE p.id = auth.uid()
              AND p.company_id = i.company_id
              AND p.role IN ('admin', 'developer')
              AND p.deleted_at IS NULL
          )
        )
    )
  );

CREATE POLICY "issue_participants_select" ON platform.issue_participants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      JOIN platform.user_profiles p ON p.company_id = i.company_id
      WHERE i.id = platform.issue_participants.issue_id
        AND p.id = auth.uid() AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "issue_participants_all" ON platform.issue_participants
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      WHERE i.id = platform.issue_participants.issue_id
        AND (
          i.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM platform.user_profiles p
            WHERE p.id = auth.uid()
              AND p.company_id = i.company_id
              AND p.role IN ('admin', 'developer')
              AND p.deleted_at IS NULL
          )
        )
    )
  );

CREATE POLICY "issue_dept_exclusions_select" ON platform.issue_department_exclusions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      JOIN platform.user_profiles p ON p.company_id = i.company_id
      WHERE i.id = platform.issue_department_exclusions.issue_id
        AND p.id = auth.uid() AND p.deleted_at IS NULL
    )
  );

CREATE POLICY "issue_dept_exclusions_all" ON platform.issue_department_exclusions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.issues i
      WHERE i.id = platform.issue_department_exclusions.issue_id
        AND (
          i.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM platform.user_profiles p
            WHERE p.id = auth.uid()
              AND p.company_id = i.company_id
              AND p.role IN ('admin', 'developer')
              AND p.deleted_at IS NULL
          )
        )
    )
  );
