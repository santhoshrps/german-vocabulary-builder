-- SOCIAL_DB 0003 — optional encrypted provider-revocation credential
-- (inventory row 2): stored at exchange when the client supplies an
-- authorizationCode and the SIWA key secrets exist; consumed by deletion
-- saga step S5 to sever the Apple-ID connection (App Store requirement).
ALTER TABLE credentials ADD COLUMN revocation BLOB;
