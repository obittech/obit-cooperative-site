// Public webhook relay. No database, message logs, reply API or public inbox.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {waReadBody,waSignatureValid} from './signature.mjs';
const siteOrigin='https://obit-business-system-owned.obittechnologies2021.chatgpt.site';
export async function relay(request,env,fetcher=fetch){
 const url=new URL(request.url);const plain=(body,status=200)=>new Response(body,{status,headers:{'Content-Type':'text/plain','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 if(url.pathname==='/health')return request.method==='GET'?plain('OK'):plain('Method not allowed',405);
 if(url.pathname!=='/webhooks/whatsapp')return plain('Not found',404);
 if(!env.META_APP_SECRET||!env.WHATSAPP_VERIFY_TOKEN||!env.OBS_SERVICE_TOKEN)return plain('Setup required',503);
 if(request.method==='GET'){
  const token=url.searchParams.get('hub.verify_token'),challenge=url.searchParams.get('hub.challenge');
  if(url.searchParams.get('hub.mode')!=='subscribe'||token!==env.WHATSAPP_VERIFY_TOKEN||!challenge||challenge.length>1024)return plain('Forbidden',403);
  return plain(challenge);
 }
 if(request.method!=='POST')return plain('Method not allowed',405);
 let raw;try{raw=await waReadBody(request)}catch{return plain('Payload too large',413)}
 const signature=request.headers.get('x-hub-signature-256');if(!await waSignatureValid(raw,signature,env.META_APP_SECRET))return plain('Forbidden',401);
 try{const response=await fetcher(siteOrigin+'/api/whatsapp/receive',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature,'OAI-Sites-Authorization':'Bearer '+env.OBS_SERVICE_TOKEN},body:raw,redirect:'manual',signal:AbortSignal.timeout(15000)});
  // Never acknowledge until the durable receiver accepted the event. Meta can retry failures.
  if(response.status!==200||!response.headers.get('content-type')?.startsWith('application/json'))return plain('Receiver unavailable',502);
  const result=await response.json();return result?.received===true?plain('EVENT_RECEIVED'):plain('Receiver unavailable',502);
 }catch{return plain('Receiver unavailable',502)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createServer(async(req,res)=>{try{
  // Bound raw request bodies before constructing the Fetch request.
  const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>262144){res.writeHead(413);res.end('Payload too large');return}parts.push(part)}
  const request=new Request('https://relay.invalid'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)});
  const response=await relay(request,process.env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
 }catch{res.writeHead(503);res.end('Service unavailable')}});
 server.requestTimeout=20000;server.headersTimeout=10000;server.listen(Number(process.env.PORT)||10000,'0.0.0.0');
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
