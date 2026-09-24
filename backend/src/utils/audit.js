import { run } from '../db.js';

export async function audit(actorUserId, action, entityType, entityId, detail = {}) {
  await run(
    `INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
    [actorUserId ?? null, action, entityType, entityId ?? null, JSON.stringify(detail)]
  );
}
