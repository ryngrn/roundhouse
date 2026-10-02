-- Revision audit is append-only and must survive replacement/re-import of the
-- current item projection. Older installations may have created this FK in v1.
ALTER TABLE roundhouse.depot_item_revisions
  DROP CONSTRAINT IF EXISTS depot_item_revisions_item_id_fkey;
