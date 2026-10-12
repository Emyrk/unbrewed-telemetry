-- 019_sandbox_deck_source.sql
-- Where a sandbox hero's deck came from (#93): the import site and the page
-- URL the relay's producer derived from p2p's deck-import logic. hero_seen
-- only; both NULL for events from a relay that predates the fields, for
-- evergreen originals, and for decks whose source is unknown.
ALTER TABLE sandbox_events
  ADD COLUMN deck_source text CHECK (deck_source IS NULL OR deck_source IN ('unmatched-club', 'unmatched-cards', 'labs')),
  ADD COLUMN deck_url text CHECK (deck_url IS NULL OR length(deck_url) <= 512),
  ADD CONSTRAINT sandbox_events_deck_pair CHECK ((deck_source IS NULL) = (deck_url IS NULL));
