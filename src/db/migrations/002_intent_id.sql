-- Migration 002 (DECISIONS D17): a caller-chosen id per purchase intent.
-- An agent that got no answer to request_purchase sends the same call again with the same intent_id and gets the
-- request it already made, instead of opening a second one that could charge twice. Optional; unique per agent.
ALTER TABLE requests ADD COLUMN intent_id TEXT;
CREATE UNIQUE INDEX requests_agent_intent ON requests(agent_id, intent_id) WHERE intent_id IS NOT NULL;
