-- company_id backfill — run from the Supabase SQL editor (not auto-applied)
--
-- STEP 1: Inspect what companies exist and identify the correct UUID.
--         Copy the id value that corresponds to Strickland Brothers.
--
SELECT id, name, created_at
FROM platform.companies
ORDER BY created_at;

-- STEP 2: Inspect which user profiles have a NULL company_id.
--
SELECT id, email, full_name, company_id
FROM platform.user_profiles
WHERE company_id IS NULL
ORDER BY email;

-- STEP 3: Backfill — paste the correct UUID from STEP 1 below.
--         The query targets only profiles with a NULL company_id.
--         DO NOT run this without first verifying the UUID from STEP 1.
--
-- UPDATE platform.user_profiles
-- SET company_id = '<UUID-FROM-STEP-1>'
-- WHERE company_id IS NULL;

-- STEP 4: Verify — no rows should remain with company_id IS NULL.
--
-- SELECT id, email, full_name, company_id
-- FROM platform.user_profiles
-- WHERE company_id IS NULL;
