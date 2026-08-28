-- Realtime Authorization for the "Join Me" feature — a private per-user
-- broadcast channel (topic 'joinme:<user_id>') that lets one user invite
-- another to jump to the page they're currently on. Without RLS on
-- realtime.messages, any authenticated client could broadcast on (spoof) or
-- listen in on (snoop) any other user's channel just by knowing their id.
--
-- Presence (the "who's online" roster, topic 'presence:...') deliberately
-- does NOT go through Realtime Authorization here — it's not marked
-- `private: true` client-side, so these policies don't apply to it. Presence
-- payloads (name/initials/current page) aren't sensitive, and this is a
-- single-tenant deployment, so an un-authorized presence channel is an
-- accepted tradeoff for simplicity. Revisit if that stops being true.

-- realtime.messages ships with RLS already enabled on Supabase-managed
-- projects — the SQL editor's role doesn't own the table, so an explicit
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY here fails with "must be owner
-- of table messages" (and isn't needed anyway). Only the policies below
-- are ours to add.

-- Any authenticated user may send a Join Me invite — the topic itself
-- (the specific target user's id) is what scopes who receives it, so no
-- further check is needed on the sender.
DROP POLICY IF EXISTS "join_me_send" ON realtime.messages;
CREATE POLICY "join_me_send" ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.topic() LIKE 'joinme:%');

-- A user may only receive on their own Join Me channel.
DROP POLICY IF EXISTS "join_me_receive" ON realtime.messages;
CREATE POLICY "join_me_receive" ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.topic() = 'joinme:' || auth.uid()::text);
