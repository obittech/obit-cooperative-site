import { get, run } from '../db.js';
import { HttpError } from '../router.js';

// Call inside the surrounding payment transaction. One bank credit cannot pay
// for both marketplace goods and a membership application.
export async function allocateBankCredit(reference, type, id) {
  await run('INSERT INTO bank_credit_allocations (bank_reference,resource_type,resource_id) VALUES (?,?,?) ON CONFLICT(bank_reference) DO NOTHING', [reference, type, id]);
  const owner = await get('SELECT * FROM bank_credit_allocations WHERE bank_reference = ?', [reference]);
  if (owner.resource_type !== type || Number(owner.resource_id) !== Number(id)) {
    throw new HttpError(409, 'This bank credit is already assigned to another payment.');
  }
}
