import {Router,HttpError} from '../router.js';
import {requireAuth} from '../middleware/auth.js';
import {all} from '../db.js';
import {whatsappConfig,verifyWhatsappSignature,enqueueWhatsapp} from '../services/whatsapp.js';
export const whatsappRouter=new Router();
whatsappRouter.get('/api/admin/whatsapp/status',requireAuth('admin'),async(req,res)=>{
 const c=whatsappConfig();
 res.json(200,{enabled:c.enabled,approval_enabled:c.approve,
  configuration_present:{signature_secret:!!c.appSecret,verification_token:!!c.verifyToken,sending_token:!!c.accessToken,phone_number_id:!!c.phoneId,waba_id:!!c.wabaId,graph_version:/^v\d+\.\d+$/.test(c.version),approver:Number.isSafeInteger(c.adminId)&&c.adminId>0},
  // Configuration presence does not prove subscription or delivery.
  events:await all('SELECT status,COUNT(*) AS count FROM whatsapp_events GROUP BY status')});
});
whatsappRouter.get('/api/admin/whatsapp/review',requireAuth('admin'),async(req,res)=>{
 res.json(200,await all("SELECT id,event_id,kind,status,result,payload,created_ms FROM whatsapp_events WHERE status='REVIEW' ORDER BY id DESC LIMIT 100"));
});
export async function handleWhatsappWebhook(req,res){
 const c=whatsappConfig();
 if(!c.enabled||!c.appSecret||!c.verifyToken||!c.phoneId||!c.wabaId)throw new HttpError(503,'WhatsApp connection is not configured');
 if(req.method==='GET'){
  const p=new URL(req.url,'https://localhost').searchParams;
  if(p.get('hub.mode')!=='subscribe'||p.get('hub.verify_token')!==c.verifyToken||!p.get('hub.challenge'))throw new HttpError(403,'Webhook verification failed');
  res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(p.get('hub.challenge'));return;
 }
 if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new HttpError(413,'Webhook payload too large');chunks.push(Buffer.from(chunk));}
 const raw=Buffer.concat(chunks);
 if(!verifyWhatsappSignature(raw,req.headers['x-hub-signature-256'],c.appSecret))throw new HttpError(401,'Webhook signature rejected');
 let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Invalid webhook JSON');}
 await enqueueWhatsapp(payload);
 res.json(200,{received:true});
}
