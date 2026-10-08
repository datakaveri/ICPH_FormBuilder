-- Who submitted each entry: the Keycloak subject (sub) of the signed-in user.
-- Entries collected before sign-in was required have no user.
ALTER TABLE entries ADD COLUMN user_id text;
CREATE INDEX entries_user_id_idx ON entries (user_id);
