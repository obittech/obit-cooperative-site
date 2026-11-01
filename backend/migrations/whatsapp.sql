CREATE TABLE IF NOT EXISTS whatsapp_events (
 id __ID__, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'READY',
 created_ms __INT__ NOT NULL, updated_ms __INT__ NOT NULL,
 result TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
 id __ID__, phone TEXT NOT NULL UNIQUE, opted_out INTEGER NOT NULL DEFAULT 0,
 last_customer_ms __INT__ NOT NULL DEFAULT 0, human_until_ms __INT__ NOT NULL DEFAULT 0
);
