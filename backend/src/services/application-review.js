import { get, run, all, atomic } from '../db.js';
import { HttpError } from '../router.js';
import { audit } from '../utils/audit.js';
const pending = ['APPLICATION_SUBMITTED','KYC_PENDING','KYC_FAILED','KYC_VERIFIED','PAYMENT_PENDING','PAYMENT_FAILED','UNDER_REVIEW'];
export async function assertApplicationNotHeld(id) {
 const review = await get('SELECT decision FROM application_reviews WHERE application_id = ?', [id]);
 if (review?.decision === 'DUPLICATE_HOLD') throw new HttpError(409, 'This application is on a recoverable duplicate hold. Contact staff; do not register or pay again.');
}
export async function reviewDetails(id) {
 const app = await get('SELECT id,full_legal_name,email,phone,status FROM member_applications WHERE id = ?', [id]);
 if (!app) throw new HttpError(404,'Application not found');
 return { application:app, registration_login_available:Boolean(await get('SELECT application_id FROM registration_credentials WHERE application_id=?',[id])), support_request:await get('SELECT message,updated_ms FROM application_support_requests WHERE application_id=?',[id])||null, review:await get('SELECT * FROM application_reviews WHERE application_id = ?', [id]) || null,
  kyc:await all('SELECT id,status,verified_at FROM kyc_checks WHERE application_id = ? ORDER BY id DESC',[id]),
  bank_payments:await all('SELECT id,status,reference FROM membership_bank_payments WHERE application_id = ?',[id]),
  provider_payments:await all('SELECT id,status,reference FROM membership_payments WHERE application_id = ?',[id]),
  members:await all('SELECT id,member_code,status FROM members WHERE application_id = ?',[id]),
  candidates:await all(`SELECT id,full_legal_name,email,phone,status FROM member_applications WHERE id <> ? AND
   ((email IS NOT NULL AND email <> '' AND lower(email)=lower(?)) OR (phone IS NOT NULL AND phone <> '' AND phone=?)) ORDER BY id`,[id,app.email,app.phone]) };
}
export async function recordReview(id, body, actor) {
 const decision=body?.decision, note=String(body?.note || '').trim();
 if (!['CONDITIONAL_ACCEPTANCE','DUPLICATE_HOLD','RELEASED'].includes(decision) || note.length<10 || note.length>1000) throw new HttpError(422,'Choose a review decision and provide a reason of 10–1000 characters.');
 return atomic(async()=>{
  const retained=decision==='DUPLICATE_HOLD'?Number(body.retained_application_id):null;
  if(retained!==null && (!Number.isSafeInteger(retained)||retained<=0||retained===Number(id))) throw new HttpError(422,'Select a different retained application.');
  // Stable lock order avoids reciprocal duplicate review deadlocks.
  for(const lockId of [...new Set([Number(id),retained].filter(x=>x!==null))].sort((a,b)=>a-b)) await run('UPDATE member_applications SET status=status WHERE id=?',[lockId]);
  const app=await get('SELECT * FROM member_applications WHERE id=?',[id]);
  if(!app) throw new HttpError(404,'Application not found');
  if(!pending.includes(app.status)) throw new HttpError(409,'Only pending applications can use this review.');
  if(await get('SELECT id FROM members WHERE application_id=?',[id]) || await get('SELECT application_id FROM membership_application_links WHERE application_id=?',[id])) throw new HttpError(409,'Existing membership requires separate reconciliation.');
  const previous=await get('SELECT * FROM application_reviews WHERE application_id=?',[id]);
  if(decision==='RELEASED' && previous?.decision!=='DUPLICATE_HOLD') throw new HttpError(409,'Only a duplicate hold can be released.');
  if(decision==='CONDITIONAL_ACCEPTANCE') {
   await assertApplicationNotHeld(id);
   if(body.acknowledge_restrictions!==true) throw new HttpError(422,'Acknowledge: no active membership, financial services, payment confirmation or identity verification is granted.');
  }
  if(decision==='DUPLICATE_HOLD') {
   if(await get("SELECT id FROM kyc_provider_requests WHERE application_id=? AND state IN ('DISPATCHED','UNKNOWN')",[id])) throw new HttpError(409,'An identity request is in progress or uncertain. Reconcile it before holding this record.');
   const target=await get('SELECT * FROM member_applications WHERE id=?',[retained]);
   if(!target || !pending.includes(target.status)) throw new HttpError(409,'Retained application must exist and be pending.');
   await assertApplicationNotHeld(retained);
   if(await get("SELECT application_id FROM application_reviews WHERE retained_application_id=? AND decision='DUPLICATE_HOLD'",[id])) throw new HttpError(409,'This application already retains another record.');
   const email=app.email && target.email && app.email.toLowerCase()===target.email.toLowerCase();
   const phone=app.phone && target.phone && app.phone===target.phone;
   if(!email || !phone || body.same_person_confirmed!==true) throw new HttpError(409,'Both email and phone must match and staff must confirm the same person. Names alone are insufficient.');
   if(await get('SELECT id FROM membership_bank_payments WHERE application_id=?',[id]) || await get('SELECT id FROM membership_payments WHERE application_id=?',[id])) throw new HttpError(409,'Payment evidence exists; reconcile it before holding this record.');
  }
  await run(`INSERT INTO application_reviews(application_id,decision,retained_application_id,note,reviewed_by,updated_ms) VALUES(?,?,?,?,?,?)
   ON CONFLICT(application_id) DO UPDATE SET decision=excluded.decision,retained_application_id=excluded.retained_application_id,note=excluded.note,reviewed_by=excluded.reviewed_by,updated_ms=excluded.updated_ms RETURNING application_id`,[id,decision,retained,note,actor,Date.now()]);
  await audit(actor,'APPLICATION_REVIEW_'+decision,'member_applications',id,{previous_decision:previous?.decision||null,retained_application_id:retained,note});
  return {review:await get('SELECT * FROM application_reviews WHERE application_id=?',[id]),active_membership_granted:false,identity_verified:false,payment_confirmed:false};
 });
}
