import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {audit} from '../utils/audit.js';
function integer(value,min,label){if(typeof value==='boolean'||value===null||value===''||!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min)throw new HttpError(400,'Invalid '+label);return Number(value);}
export function videoInput(value){
 if(typeof value!=='string'||value.length>2048)throw new HttpError(400,'Use a YouTube video link or a public HTTPS MP4 link');
 let u;try{u=new URL(value.trim());}catch{throw new HttpError(400,'Use a YouTube video link or a public HTTPS MP4 link');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw new HttpError(400,'Use an HTTPS video link without a password or fragment');
 let id;const host=u.hostname.toLowerCase();
 if(host==='youtu.be')id=u.pathname.slice(1);
 else if(['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(host))id=u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/)?.[1];
 if(id&&/^[a-zA-Z0-9_-]{11}$/.test(id))return {url:'https://www.youtube.com/watch?v='+id,kind:'youtube',embed:'https://www.youtube-nocookie.com/embed/'+id+'?rel=0'};
 if(/(?:^|\.)youtube(?:-nocookie)?\.com$/.test(host)||host==='youtu.be')throw new HttpError(400,'Use a link to one YouTube video');
 // Public DNS names only. We never fetch supplied links on the server.
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)||/\.(?:localhost|local|internal|test|invalid|example)$/.test(host)||host==='localhost'||!u.pathname.toLowerCase().endsWith('.mp4'))throw new HttpError(400,'Use a public HTTPS link ending in .mp4 or a YouTube video link');
 return {url:u.href,kind:'mp4',embed:null};
}
export function publicVideo(row){if(!row?.video_url||row.video_status!=='APPROVED')return null;try{const v=videoInput(row.video_url);return {url:v.url,kind:v.kind,description:row.video_description};}catch{return null;}}
// Called only inside the transaction that creates the seller-owned listing.
export async function initialVideo(userId,listingId,body){
 const v=videoInput(body?.video_url),description=body?.video_description;
 if(typeof description!=='string'||description.trim().length<10||description.trim().length>500)throw new HttpError(400,'Describe what the video shows in 10 to 500 characters');
 await run("INSERT INTO market_listing_videos (listing_id,video_url,description,status,version,submitted_ms) VALUES (?,?,?,'PENDING',1,?)",[listingId,v.url,description.trim(),Date.now()]);
 await audit(userId,'MARKET_VIDEO_SUBMITTED','market_listings',listingId,{version:1});
}
export async function submitVideo(userId,listingId,body){
 listingId=integer(listingId,1,'product');const version=integer(body?.version,0,'video version');
 const v=videoInput(body?.video_url),description=body?.description;
 if(typeof description!=='string'||description.trim().length<10||description.trim().length>500)throw new HttpError(400,'Describe what the video shows in 10 to 500 characters');
 return atomic(async()=>{
  const listing=await get("SELECT l.id FROM market_listings l JOIN members m ON m.id=l.seller_member_id JOIN users u ON u.id=m.user_id WHERE l.id=? AND m.user_id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND l.status IN ('DRAFT','ACTIVE','PAUSED')",[listingId,userId]);
  if(!listing)throw new HttpError(404,'Product not found');
  await run('UPDATE market_listings SET title=title WHERE id=?',[listingId]);
  const old=await get('SELECT version FROM market_listing_videos WHERE listing_id=?',[listingId]);
  if(Number(old?.version||0)!==version)throw new HttpError(409,'Video changed. Refresh before saving');
  const next=version+1;
  if(old)await run("UPDATE market_listing_videos SET video_url=?,description=?,status='PENDING',version=?,submitted_ms=?,reviewed_by=NULL,reviewed_ms=NULL,review_note='' WHERE listing_id=?",[v.url,description.trim(),next,Date.now(),listingId]);
  else await run("INSERT INTO market_listing_videos (listing_id,video_url,description,status,version,submitted_ms) VALUES (?,?,?,'PENDING',?,?)",[listingId,v.url,description.trim(),next,Date.now()]);
  await audit(userId,'MARKET_VIDEO_SUBMITTED','market_listings',listingId,{version:next});
  return {listing_id:listingId,status:'PENDING',version:next};
 });
}
async function staff(userId){const u=await get('SELECT role,status FROM users WHERE id=?',[userId]);if(u?.status!=='ACTIVE'||!['staff','admin'].includes(u.role))throw new HttpError(403,'Staff access required');}
export async function videoReviews(userId){await staff(userId);return all('SELECT v.*,l.title,l.status AS listing_status,m.member_code FROM market_listing_videos v JOIN market_listings l ON l.id=v.listing_id JOIN members m ON m.id=l.seller_member_id ORDER BY v.submitted_ms DESC LIMIT 200');}
export async function reviewVideo(userId,listingId,body){
 await staff(userId);listingId=integer(listingId,1,'product');const version=integer(body?.version,1,'video version'),decision=body?.decision,note=body?.note;
 if(!['APPROVE','REJECT'].includes(decision))throw new HttpError(400,'Choose approve or reject');
 if(typeof note!=='string'||note.trim().length<10||note.trim().length>500)throw new HttpError(400,'Add a review note of 10 to 500 characters');
 if(decision==='APPROVE'&&body?.confirmed!==true)throw new HttpError(400,'Confirm the video matches the product and may be published');
 return atomic(async()=>{
  const old=await get('SELECT v.*,l.status AS listing_status FROM market_listing_videos v JOIN market_listings l ON l.id=v.listing_id WHERE v.listing_id=?',[listingId]);
  if(!old)throw new HttpError(404,'Video not found');
  if(old.listing_status==='REMOVED'&&decision==='APPROVE')throw new HttpError(409,'Removed products cannot publish videos');
  if(decision==='APPROVE')videoInput(old.video_url);
  const status=decision==='APPROVE'?'APPROVED':'REJECTED';
  const r=await run('UPDATE market_listing_videos SET status=?,version=version+1,reviewed_by=?,reviewed_ms=?,review_note=? WHERE listing_id=? AND version=?',[status,userId,Date.now(),note.trim(),listingId,version]);
  if(r.changes!==1)throw new HttpError(409,'Video changed during review. Refresh and review again');
  await audit(userId,'MARKET_VIDEO_'+decision,'market_listings',listingId,{version:version+1});
  return {listing_id:listingId,status,version:version+1};
 });
}
