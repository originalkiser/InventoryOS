-- Phase 3: literal duplicate — condition_rules_read (SELECT) has the
-- identical condition as condition_rules_write (ALL).
DROP POLICY IF EXISTS "condition_rules_read" ON forms.condition_rules;
