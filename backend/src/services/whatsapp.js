import crypto from 'node:crypto';
import {get,all,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {audit} from '../utils/audit.js';
import {parseNgnToKobo} from '../utils/money.js';
import {allocateBankCredit} from './bank-credit.js';
import {activateReviewedApplication} from './membership-activation.js';
import {awardReferralBonus} from './member-referrals.js';

export const businessPhone='2348030567787';
const phone=v=>String(v||'').replace(/\D/g,'').replace(/^0(?=\d{10}$)/,'234');
export function whatsappConfig(){
 const env=process.env;
 return {enabled:env.WHATSAPP_ENABLED==='true',approve:env.WHATSAPP_APPROVAL_ENABLED==='true',
  appSecret:env.WHATSAPP_APP_SECRET||'',verifyToken:env.WHATSAPP_VERIFY_TOKEN||'',
  accessToken:env.WHATSAPP_ACCESS_TOKEN||'',phoneId:env.WHATSAPP_PHONE_NUMBER_ID||'',
  wabaId:env.WHATSAPP_WABA_ID||'',version:env.WHATSAPP_GRAPH_VERSION||'',
  adminId:Number(env.WHATSAPP_APPROVER_USER_ID)};
}
export function verifyWhatsappSignature(raw,signature,secret){
 if(!secret||!/^sha256=[a-f\d]{64}$/.test(String(signature||'')))return false;
 const actual=Buffer.from(signature.slice(7),'hex');
 return crypto.timingSafeEqual(actual,crypto.createHmac('sha256',secret).update(raw).digest());
}
export function parseConfirmation(text){
 const m=/^CONFIRM MEMBERSHIP (OBIT-MEM-[A-F\d]{32}) AMOUNT (\d+(?:\.\d{1,2})?) BANK ([A-Za-z\d][A-Za-z\d._/-]{5,119})$/i.exec(String(text||'').trim());
 if(!m)return null;
 try{return {reference:m[1].toUpperCase(),amountKobo:parseNgnToKobo(m[2]),bankReference:m[3]};}catch{return null;}
}
// Untrusted customer text is never evaluated as an approval command or prompt.
// Only fixed business answers are sent. Unknown questions go to a human.
export function businessReply(text){
 const t=String(text||'').toLowerCase();
 if(/\b(stop|unsubscribe)\b/.test(t))return 'Automatic WhatsApp replies are now stopped. Send START to resume.';
 if(/\b(human|agent|staff|complaint|refund|dispute)\b/.test(t))return 'Your message has been marked for an Obit staff member. Please leave the details here. Do not send your password, PIN or verification codes.';
 if(/\b(paid|payment|transfer|receipt|confirmed)\b/.test(t))return 'Thank you. Please send your application or order reference and the payment receipt. Obit staff will check the actual bank credit. A receipt or “I have paid” message alone does not activate membership. Do not send your PIN, password or verification code.';
 if(/\b(solar|kiosk|ffk|investment|returns|loan)\b/.test(t))return 'Obit staff will confirm the current terms and availability for this service. Please tell us which service you need and your location.';
 if(/\b(cooperative|membership|member|join)\b/.test(t))return 'Obit Technologies Multipurpose Cooperative Society Limited supports members through community and technology. Apply at https://obitcooperative.com and follow the identity verification and payment steps shown there. Approved members use their membership code and password for Finance and seller access. Buyers can browse https://marketplace.obitcooperative.com without joining.';
 if(/\b(obs|software|technology|technologies|website|automation|business system)\b/.test(t))return 'Obit Technologies Limited provides software and business automation services. OBS has Starter at ₦25,000 monthly for four core systems and Business at ₦100,000 monthly for all eight. Please tell us your business type and what you need help with. Details: https://obittechnologies.com';
 if(/\b(finance|savings|contribution|balance)\b/.test(t))return 'Members can use their cooperative membership code and password at https://finance.obitcooperative.com to view the records available to their account. Please use the portal for private financial details. For a correction, leave your application or membership reference for staff.';
 if(/\b(market|buy|sell|product|order)\b/.test(t))return 'Browse Obit Market at https://marketplace.obitcooperative.com. Buyers can browse without membership. Sellers must be approved cooperative members and sign in using their membership code and password. Staff can help with payment, delivery and order questions.';
 return 'Hello, this is the Obit automated assistant. Are you asking about 1. Obit Technologies and OBS, 2. Cooperative membership, 3. Finance, or 4. Obit Market? You can also type HUMAN for staff assistance.';
}
export async function enqueueWhatsapp(payload,now=Date.now()){
 const c=whatsappConfig();
 if(!c.enabled||!c.phoneId||!c.wabaId)throw new HttpError(503,'WhatsApp connection is not configured');
 if(payload?.object!=='whatsapp_business_account')return 0;
 let count=0;
 for(const entry of payload.entry||[]){
  if(String(entry.id)!==c.wabaId)continue;
  for(const change of entry.changes||[]){
   const v=change.value;
   if(v?.messaging_product!=='whatsapp'||String(v?.metadata?.phone_number_id)!==c.phoneId||phone(v.metadata.display_phone_number)!==businessPhone)continue;
   const echo=change.field==='smb_message_echoes';
   if(!echo&&change.field!=='messages')continue;
   for(const m of (echo?v.message_echoes:v.messages)||[]){
    if(m.type!=='text'||typeof m.id!=='string'||m.id.length>250||typeof m.text?.body!=='string'||m.text.body.length>4096)continue;
    const seconds=Number(m.timestamp),age=now-seconds*1000;
    if(!Number.isSafeInteger(seconds)||age< -30000||age>(echo?15*60*1000:23*60*60*1000))continue;
    const from=phone(m.from),to=phone(m.to);
    if(echo?from!==businessPhone:(!/^\d{10,15}$/.test(from)||from===businessPhone))continue;
    if(echo&&!/^\d{10,15}$/.test(to))continue;
    const item={from,to,text:m.text.body,timestamp:seconds};
    const r=await run(`INSERT INTO whatsapp_events(event_id,kind,payload,created_ms,updated_ms) VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING RETURNING id`,[m.id,echo?'BUSINESS_ECHO':'CUSTOMER',JSON.stringify(item),now,now]);
    if(r.changes&&!echo)await run('INSERT INTO whatsapp_contacts(phone,last_customer_ms) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET last_customer_ms=CASE WHEN excluded.last_customer_ms>whatsapp_contacts.last_customer_ms THEN excluded.last_customer_ms ELSE whatsapp_contacts.last_customer_ms END RETURNING id',[from,seconds*1000]);
    count+=r.changes;
   }
  }
 }
 return count;
}
async function confirmMembership(item,c){
 const command=parseConfirmation(item.text);
 if(!command)return null;
 if(!c.approve||!Number.isSafeInteger(c.adminId)||c.adminId<1)throw new HttpError(503,'WhatsApp payment approval is not enabled');
 return atomic(async()=>{
  const actor=await get("SELECT id FROM users WHERE id=? AND role='admin' AND status='ACTIVE'",[c.adminId]);
  if(!actor)throw new HttpError(403,'Designated administrator is unavailable');
  const initial=await get('SELECT * FROM membership_bank_payments WHERE reference=?',[command.reference]);
  if(!initial)throw new HttpError(404,'Unknown membership payment');
  await run('UPDATE member_applications SET status=status WHERE id=?',[initial.application_id]);
  await run('UPDATE membership_bank_payments SET status=status WHERE id=?',[initial.id]);
  const row=await get('SELECT * FROM membership_bank_payments WHERE id=?',[initial.id]);
  const app=await get('SELECT * FROM member_applications WHERE id=?',[row.application_id]);
  if(![app.whatsapp,app.phone].some(n=>phone(n)===item.to))throw new HttpError(409,'Confirmation must be sent to the registered applicant chat');
  if(Number(row.amount_kobo)!==command.amountKobo)throw new HttpError(409,'Amount does not match the saved membership fee');
  // Reject old failed KYC and local dev simulations before automatic activation.
  const kyc=await get('SELECT * FROM kyc_checks WHERE application_id=? ORDER BY id DESC LIMIT 1',[app.id]);
  if(!kyc||kyc.status!=='KYC_VERIFIED'||String(kyc.provider).toLowerCase()!=='youverify'||!String(kyc.session_ref).startsWith('youverify_live_'))throw new HttpError(409,'Verified production identity check required');
  if(row.status==='CONFIRMED'){
   if(row.bank_reference!==command.bankReference)throw new HttpError(409,'Payment already uses another bank reference');
   if(app.status==='ACTIVE')return get('SELECT member_code FROM members WHERE application_id=?',[app.id]);
   if(app.status!=='UNDER_REVIEW')throw new HttpError(409,'Application requires staff review');
  }else{
   if(row.status!=='CLAIMED'||app.status!=='PAYMENT_PENDING')throw new HttpError(409,'Application is not awaiting this reported payment');
   await allocateBankCredit(command.bankReference,'MEMBERSHIP',row.id);
   await run("UPDATE membership_bank_payments SET status='CONFIRMED',bank_reference=?,confirmed_ms=?,confirmed_by=? WHERE id=?",[command.bankReference,Date.now(),actor.id,row.id]);
   await run("UPDATE member_applications SET status='UNDER_REVIEW',updated_at=datetime('now') WHERE id=?",[app.id]);
   app.status='UNDER_REVIEW';
   await audit(actor.id,'MEMBERSHIP_TRANSFER_CONFIRMED','member_applications',app.id,{reference:row.reference,channel:'whatsapp'});
  }
  const member=await activateReviewedApplication(app);
  await awardReferralBonus(app.id,actor.id);
  await audit(actor.id,'APPLICATION_DECISION_APPROVE','member_applications',app.id,{channel:'whatsapp',reference:row.reference});
  return member;
 });
}
async function sendReply(to,text,c,fetcher){
 if(!c.accessToken||!/^v\d+\.\d+$/.test(c.version))throw new Error('WhatsApp sending is not configured');
 const r=await fetcher(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${c.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:text}}),redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error('Provider did not accept the reply');
}
let draining=false;
export async function processWhatsappQueue(fetcher=fetch){
 if(draining||!whatsappConfig().enabled)return;
 draining=true;
 try{
  // A crash after an outbound request has an unknown delivery outcome. Do not resend it.
  await run("UPDATE whatsapp_events SET status='REVIEW',result='Delivery or processing outcome uncertain' WHERE status IN ('SENDING','PROCESSING') AND updated_ms<?",[Date.now()-120000]);
  for(const event of await all("SELECT * FROM whatsapp_events WHERE status='READY' ORDER BY id LIMIT 10")){
   const claimed=await run("UPDATE whatsapp_events SET status='PROCESSING',updated_ms=? WHERE id=? AND status='READY'",[Date.now(),event.id]);
   if(!claimed.changes)continue;
   try{
    const item=JSON.parse(event.payload),c=whatsappConfig();
    if(Date.now()-item.timestamp*1000>(event.kind==='BUSINESS_ECHO'?15*60*1000:23*60*60*1000))throw new Error('Message expired before processing');
    if(event.kind==='BUSINESS_ECHO'){
     // Any manual response gives staff the conversation for 24 hours.
     await run('INSERT INTO whatsapp_contacts(phone,human_until_ms) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET human_until_ms=excluded.human_until_ms RETURNING id',[item.to,Date.now()+86400000]);
     const result=await confirmMembership(item,c);
     const recipient=await get('SELECT * FROM whatsapp_contacts WHERE phone=?',[item.to]);
     if(result?.member_code&&!Number(recipient?.opted_out)&&Number(recipient?.last_customer_ms)>Date.now()-23*60*60*1000){
      await run("UPDATE whatsapp_events SET status='SENDING',updated_ms=? WHERE id=?",[Date.now(),event.id]);
      await sendReply(item.to,`Your Obit Cooperative membership is active. Membership code: ${result.member_code}. Open https://obitcooperative.com to set up your member password. Keep your password and verification codes private.`,c,fetcher);
     }
     await run("UPDATE whatsapp_events SET status='DONE',result=?,updated_ms=? WHERE id=?",[result?'Membership approved':'Human takeover',Date.now(),event.id]);
    }else{
     const contact=await get('SELECT * FROM whatsapp_contacts WHERE phone=?',[item.from]);
     const stop=/\b(stop|unsubscribe)\b/i.test(item.text),start=/^START$/i.test(item.text.trim());
     if(stop||start)await run('INSERT INTO whatsapp_contacts(phone,opted_out) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET opted_out=excluded.opted_out RETURNING id',[item.from,stop?1:0]);
     if((Number(contact?.opted_out)&&!start)||Number(contact?.human_until_ms)>Date.now()){
      await run("UPDATE whatsapp_events SET status='DONE',result='Held for staff or opted out' WHERE id=?",[event.id]);continue;
     }
     const handoff=/\b(human|agent|staff|complaint|refund|dispute|solar|kiosk|ffk|investment|returns|loan)\b/i.test(item.text);
     if(handoff)await run('INSERT INTO whatsapp_contacts(phone,opted_out,human_until_ms) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET opted_out=excluded.opted_out,human_until_ms=excluded.human_until_ms RETURNING id',[item.from,stop?1:0,handoff?Date.now()+86400000:0]);
     await run("UPDATE whatsapp_events SET status='SENDING',updated_ms=? WHERE id=?",[Date.now(),event.id]);
     await sendReply(item.from,businessReply(item.text),c,fetcher);
     await run("UPDATE whatsapp_events SET status='DONE',result='Reply accepted by provider',updated_ms=? WHERE id=?",[Date.now(),event.id]);
    }
   }catch(error){
    // Keep details in the staff system. Never log message contents, credentials or bank references.
    await run("UPDATE whatsapp_events SET status='REVIEW',result=?,updated_ms=? WHERE id=?",[error instanceof HttpError?error.message:'Staff review required',Date.now(),event.id]);
   }
  }
  await run("UPDATE whatsapp_events SET payload='{}' WHERE status='REVIEW' AND created_ms<?",[Date.now()-30*86400000]);
  await run("DELETE FROM whatsapp_events WHERE status='DONE' AND created_ms<?",[Date.now()-30*86400000]);
 }finally{draining=false;}
}
