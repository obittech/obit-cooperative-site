import crypto from 'node:crypto';
import { get, run } from '../db.js';

function timingSafeHex(a,b){
  try {
    const aa=Buffer.from(String(a||'').replace(/^sha256=/i,''),'hex');
    const bb=Buffer.from(String(b||'').replace(/^sha256=/i,''),'hex');
    return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb);
  } catch { return false; }
}
async function readRaw(req){
  const chunks=[]; let total=0;
  for await (const chunk of req){ total+=chunk.length; if(total>1024*1024) throw new Error('Webhook body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function handleSafePayWebhook(req,res,{provider}){
  if(process.env.SAFEPAY_PROVIDER_ENABLED!=='true') return res.json(503,{error:'SafePay provider is disabled'});
  if(process.env.SAFEPAY_WEBHOOK_SIGNATURE_MODE!=='hmac-sha256') return res.json(503,{error:'SafePay webhook signature contract is not configured'});
  const secret=process.env.SAFEPAY_WEBHOOK_SECRET;
  const headerName=String(process.env.SAFEPAY_WEBHOOK_HEADER||'x-safepay-signature').toLowerCase();
  if(!secret) return res.json(503,{error:'SafePay webhook secret is not configured'});
  const raw=await readRaw(req);
  const supplied=req.headers[headerName];
  const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex');
  if(!timingSafeHex(supplied,expected)) return res.json(401,{error:'Invalid SafePay webhook signature'});
  let payload; try{payload=JSON.parse(raw.toString('utf8'));}catch{return res.json(400,{error:'Invalid JSON'});}
  const eventId=String(payload.id||payload.event_id||'').trim();
  const eventType=String(payload.type||payload.event||'').trim();
  const escrowId=String(payload.escrow_id||payload.data?.escrow_id||payload.data?.id||'').trim();
  if(!eventId||!eventType||!escrowId) return res.json(422,{error:'Webhook event is missing required identifiers'});
  const existing=await get('SELECT id,processed FROM safepay_events WHERE provider=? AND event_id=?',[provider,eventId]);
  if(existing) return res.json(200,{ok:true,idempotent:true});
  const order=await get('SELECT * FROM market_orders WHERE provider=? AND provider_escrow_id=?',[provider,escrowId]);
  const inserted=await run('INSERT INTO safepay_events (provider,event_id,order_id,event_type,payload_json,processed) VALUES (?,?,?,?,?,0)',
    [provider,eventId,order?.id||null,eventType,JSON.stringify(payload)]);
  if(!order) return res.json(202,{ok:true,matched:false,event_id:eventId});
  const fundedEvent=String(process.env.SAFEPAY_FUNDED_EVENT||'');
  if(!fundedEvent || eventType!==fundedEvent) return res.json(202,{ok:true,matched:true,transitioned:false,event_type:eventType});
  if(order.status!=='AWAITING_FUNDING') return res.json(200,{ok:true,idempotent:true,status:order.status});
  await run("UPDATE market_orders SET status='FUNDED',updated_at=datetime('now') WHERE id=?",[order.id]);
  await run('UPDATE safepay_events SET processed=1 WHERE id=?',[inserted.lastInsertRowid]);
  return res.json(200,{ok:true,order_id:order.id,status:'FUNDED'});
}
