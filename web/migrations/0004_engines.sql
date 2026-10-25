-- More than one engine per chain (FlowEngine v4 next to the v3 engine whose notes stay where they are).
--
-- `chains.chain` is now the indexer's own key for one (chain, engine) pair: the chain key for the current engine
-- and e.g. `arbitrum-sepolia-v3` for an earlier one. Note ids, notes.chain, events.chain, definitions.chain and
-- changes.chain keep the real chain key, so every existing note id stays the same.
--
-- events gets the engine that emitted each event, so a reorg on one engine's cursor only undoes that engine's
-- events. Rows written before this migration all come from the one engine their chain row names. The Worker sets
-- the engine on any event the old build inserts after this migration, when it first adopts the chain's row for
-- the earlier engine (services/edge/src/ingest.ts, D1Ingestor.init).
ALTER TABLE events ADD COLUMN engine TEXT;
UPDATE events SET engine = (SELECT c.engine FROM chains c WHERE c.chain = events.chain) WHERE engine IS NULL;
CREATE INDEX events_chain_engine_block ON events (chain, engine, block);
