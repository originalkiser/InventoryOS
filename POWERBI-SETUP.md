# Power BI — connecting directly to InventoryOS data

No custom connector, API, or export step needed. Power BI's built-in
**PostgreSQL database** connector talks straight to Supabase's underlying
Postgres instance — the same way it would connect to any other Postgres
database. This doc covers the one-time setup and the ongoing "just
authenticate and pull" flow.

## One-time setup (you, not Power BI)

1. Apply `supabase/migrations/20260901c_powerbi_reader_role.sql` — creates a
   read-only login (`powerbi_reader`) that can only `SELECT` from:
   - `inventory.droptop_customers` (customer profiles + resolved lat/lng)
   - `inventory.zip_centroids` (the zip → lat/lng lookup they're plotted against)
   - `core.locations` (so a report can join a customer back to a shop name/region)

2. **Set a real password immediately** — the migration creates the role with
   a placeholder, not a usable credential. In the Supabase SQL editor:
   ```sql
   ALTER ROLE powerbi_reader WITH PASSWORD 'a real generated password, not this text';
   ```
   Use a password manager to generate it; store it wherever your team keeps
   service credentials (not in this repo).

3. Find your connection host: Supabase Dashboard → your project → **Project
   Settings → Database → Connection string**. Use the **Session pooler**
   entry (not "Transaction pooler") — Power BI's import/DirectQuery modes
   expect a session-style connection, which the transaction pooler doesn't
   support well. It looks like:
   ```
   Host:     aws-0-<region>.pooler.supabase.com
   Port:     5432
   Database: postgres
   ```

## Connecting from Power BI Desktop

1. **Get Data → More → Database → PostgreSQL database**
2. Server: `<the pooler host from above>:5432`
3. Database: `postgres`
4. Data Connectivity mode: **Import** (recommended — customer/location data
   changes slowly; refresh on a schedule rather than DirectQuery hitting the
   database live) or DirectQuery if you specifically want always-current data
5. Under advanced options, if prompted for the user, it's:
   ```
   postgres.<your-project-ref>
   ```
   (Supabase's pooler requires the project ref suffixed onto the username —
   copy the exact user string shown in the same connection-string panel from
   step 3 above, don't just use `powerbi_reader` alone)
6. Password: the one you set in step 2
7. Navigator will show `inventory.droptop_customers`, `inventory.zip_centroids`,
   and `core.locations` — pick what you need and Load/Transform as normal

## Extending access later

More tables/schemas can be exposed the same way — one more migration with:
```sql
GRANT USAGE ON SCHEMA <schema> TO powerbi_reader;          -- if a new schema
GRANT SELECT ON <schema>.<table> TO powerbi_reader;
CREATE POLICY "<table>_powerbi" ON <schema>.<table>
  FOR SELECT TO powerbi_reader USING (true);
```
Keep it additive and explicit per table rather than granting a whole schema's
worth of tables at once — this role's access should stay auditable from the
migrations folder alone.

## Refreshing the data on a schedule

Power BI Desktop reports published to the Power BI **service** (not just kept
local) can be set to refresh on a schedule via a **data gateway** (or none at
all if Supabase's host is already internet-reachable, which it is — no VPN/
on-prem gateway needed for this connection specifically). Set the refresh
cadence to roughly match how often you're running the Droptop — Customers
sync in Config → Data Connections; refreshing more often than the underlying
sync runs just re-reads the same data.
