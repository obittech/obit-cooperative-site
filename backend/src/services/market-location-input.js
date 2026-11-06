import fs from 'node:fs';
import {HttpError} from '../router.js';
import {videoInput} from './market-media.js';
const regions=JSON.parse(fs.readFileSync(new URL('../data/market-regions.json',import.meta.url),'utf8'));
export function directoryRegions(){return regions;}
function text(v,min,max,label){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw new HttpError(400,'Check '+label);return v.trim();}
export function locationInput(input){
 if(!input||typeof input!=='object')throw new HttpError(400,'Add your shop location');
 const p={};for(const [k,min,max] of [['state',2,50],['lga',2,100],['community',2,100],['cluster',0,120],['shop_number',0,60],['address',5,300],['landmark',0,200],['hours',0,200],['keywords',2,500],['phone',0,20]])p[k]=text(input[k]??'',min,max,k.replaceAll('_',' '));
 if(!regions.areas[p.state]?.includes(p.lga))throw new HttpError(400,'Select a valid state and local government / area council');
 p.zone=Object.keys(regions.zones).find(z=>regions.zones[z].includes(p.state));
 p.kind=text(input.kind,3,20,'shop type');if(!['market','plaza','standalone'].includes(p.kind))throw new HttpError(400,'Choose a market, plaza or standalone shop');
 if(p.kind!=='standalone'&&!p.cluster)throw new HttpError(400,'Enter the market or plaza name');
 if(p.phone&&!/^\+?[0-9 ]{7,20}$/.test(p.phone))throw new HttpError(400,'Check public business phone');
 const lat=input.latitude,lon=input.longitude,blank=v=>v===undefined||v===null||v==='';
 p.latitude=null;p.longitude=null;
 if(!blank(lat)||!blank(lon)){if(blank(lat)||blank(lon)||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon))||Math.abs(Number(lat))>90||Math.abs(Number(lon))>180)throw new HttpError(400,'Enter both valid map coordinates');p.latitude=Number(lat);p.longitude=Number(lon);}
 p.image_url='';if(input.image_url){let u;try{u=new URL(input.image_url);}catch{throw new HttpError(400,'Use a public HTTPS shop photo link');}if(u.protocol!=='https:'||u.username||u.password||u.port||input.image_url.length>2048)throw new HttpError(400,'Use a public HTTPS shop photo link');p.image_url=u.href;}
 p.video_url=input.video_url?videoInput(input.video_url).url:'';
 if((p.image_url||p.video_url)&&input.content_authorised!==true)throw new HttpError(400,'Confirm permission for your shop photos and video');
 p.content_authorised=input.content_authorised===true;return p;
}
