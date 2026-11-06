import {all,get} from '../db.js';
import {HttpError} from '../router.js';
import {publicTrialShops} from './market-trials.js';
export {locationInput,directoryRegions} from './market-location-input.js';
export function parseLocation(row){try{return row?.profile_json?JSON.parse(row.profile_json):null;}catch{return null;}}
function shop(row){const p=parseLocation(row);return {id:Number(row.seller_member_id),name:row.name,description:row.description,official:Number(row.official)===1,location_verified:Number(row.location_verified)===1,location:p};}
const PUBLIC=" FROM market_stores s JOIN members m ON m.id=s.seller_member_id JOIN market_shop_locations d ON d.seller_member_id=s.seller_member_id WHERE s.status='APPROVED' AND m.status='ACTIVE'";
export async function directoryShop(id){if(/^trial-[1-9]\d*$/.test(String(id))){const shop=(await publicTrialShops()).find(s=>s.id===id);if(!shop)throw new HttpError(404,'This shop is not publicly available');return shop;}if(!/^[1-9]\d*$/.test(String(id)))throw new HttpError(400,'Invalid shop');const r=await get('SELECT s.seller_member_id,s.name,s.description,s.official,d.profile_json,d.location_verified'+PUBLIC.replace('JOIN market_shop_locations','LEFT JOIN market_shop_locations')+' AND s.seller_member_id=?',[Number(id)]);if(!r)throw new HttpError(404,'This shop is not publicly available');return shop(r);}
export async function directory(search){
 const rows=await all('SELECT s.seller_member_id,s.name,s.description,s.official,d.profile_json,d.location_verified'+PUBLIC+' ORDER BY s.id DESC');
 let results=[...rows.map(shop).filter(s=>s.location),...await publicTrialShops()];const goods=new Map();const listings=await all(`SELECT l.seller_member_id,l.title,l.description,l.category FROM market_listings l JOIN communities c ON c.id=l.community_id WHERE l.status='ACTIVE' AND c.status='ACTIVE' AND c.slug='obit-cooperative' AND NOT EXISTS (SELECT 1 FROM market_supplier_drafts sd WHERE sd.listing_id=l.id AND sd.valid_until_ms<=?)`,[Date.now()]);for(const l of listings)goods.set(Number(l.seller_member_id),(goods.get(Number(l.seller_member_id))||'')+' '+l.title+' '+(l.description||'')+' '+l.category);const norm=v=>String(v||'').toLowerCase().trim();
 const q=norm(search.get('q'));if(q.length>120)throw new HttpError(400,'Search is too long');
 const synonyms={'cheap':'affordable','cloths':'clothes','clothing':'clothes','fashion':'clothes'};
 const words=q.split(/\s+/).filter(w=>w&&!['in','at','near','me','around','the','and','for'].includes(w)).map(w=>synonyms[w]||w);
 results=results.filter(s=>{let t=norm([s.name,s.description,goods.get(s.id)||'',...(s.products||[]).map(p=>p.title+' '+p.description),...Object.values(s.location).filter(v=>typeof v==='string')].join(' '));t=t.replace(/\b(clothing|cloths|fashion)\b/g,'clothes');return words.every(w=>t.includes(w));});
 for(const key of ['zone','state','lga','community','cluster','kind']){const v=norm(search.get(key));if(v)results=results.filter(s=>norm(s.location[key])===v);}
 if(search.get('video')==='1')results=results.filter(s=>s.location.video_url);
 const radius=Number(search.get('radius')||25);if(!Number.isFinite(radius)||radius<1||radius>500)throw new HttpError(400,'Choose a search radius from 1 to 500 km');
 let near=false;const lat=search.get('lat'),lon=search.get('lon');
 if(lat!==null||lon!==null){if(lat===null||lon===null||lat===''||lon===''||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon))||Math.abs(Number(lat))>90||Math.abs(Number(lon))>180)throw new HttpError(400,'Invalid search location');near=true;const rad=n=>n*Math.PI/180;for(const s of results){const p=s.location;if(p.latitude===null||p.longitude===null){s.distance_km=null;continue;}const a=Math.sin(rad(p.latitude-Number(lat))/2)**2+Math.cos(rad(Number(lat)))*Math.cos(rad(p.latitude))*Math.sin(rad(p.longitude-Number(lon))/2)**2;s.distance_km=Math.round(6371*2*Math.asin(Math.sqrt(Math.min(1,a)))*10)/10;}results=results.filter(s=>s.distance_km!==null&&s.distance_km<=radius);results.sort((a,b)=>a.distance_km-b.distance_km);}
 const page=Number(search.get('page')||1);if(!Number.isInteger(page)||page<1||page>100000)throw new HttpError(400,'Invalid page');
 const total=results.length;const clusters=new Map();for(const s of results){const p=s.location;if(!p.cluster)continue;const key=[p.state,p.lga,p.community,p.kind,p.cluster].join('|');const old=clusters.get(key);if(old)old.shops++;else clusters.set(key,{...Object.fromEntries(['state','lga','community','kind','cluster'].map(k=>[k,p[k]])),shops:1});}
 return {items:results.slice((page-1)*24,page*24),total,page,page_size:24,near,clusters:[...clusters.values()]};
}
