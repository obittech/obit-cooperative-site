import { get, all, run } from '../db.js';
import { generateMemberCode } from '../utils/auth.js';

// Call inside the approval transaction. Lock one counter per year so approvals
// of different applications cannot choose the same membership code.
export async function nextMemberCode() {
  const year = String(new Date().getFullYear());
  await run('INSERT INTO member_code_sequences (code_year,last_value) VALUES (?,0) ON CONFLICT(code_year) DO NOTHING RETURNING code_year', [year]);
  const counter = await get('UPDATE member_code_sequences SET last_value=last_value WHERE code_year=? RETURNING last_value', [year]);
  if (Number(counter.last_value) === 0) {
    const previous = await all('SELECT member_code FROM members WHERE member_code LIKE ?', [`OBT-${year}-%`]);
    const highest = previous.reduce((max, row) => {
      const suffix = row.member_code.slice(9);
      const value = /^\d+$/.test(suffix) ? Number(suffix) : 0;
      return Number.isSafeInteger(value) ? Math.max(max, value) : max;
    }, 0);
    await run('UPDATE member_code_sequences SET last_value=? WHERE code_year=?', [highest, year]);
  }
  const next = await get('UPDATE member_code_sequences SET last_value=last_value+1 WHERE code_year=? RETURNING last_value', [year]);
  return generateMemberCode(Number(next.last_value));
}
