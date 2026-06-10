-- Allow authenticated users to create a company (needed for setup flow)
create policy "Authenticated users can create companies"
  on companies for insert
  with check (auth.uid() is not null);

-- Allow users to insert their own profile row
create policy "Users can insert own profile"
  on profiles for insert
  with check (id = auth.uid());
