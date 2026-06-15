-- Admin-only user creation: let an admin insert a profile row for a NEW user in
-- their company (the invite flow). Without this, the only insert policy is
-- "id = auth.uid()", which blocks an admin from creating someone else's profile.
drop policy if exists "Admins can insert company profiles" on profiles;
create policy "Admins can insert company profiles"
  on profiles for insert
  with check (company_id = get_my_company_id() and is_admin());
