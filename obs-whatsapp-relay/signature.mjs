const waJson=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function waSignatureValid(raw,signature,secret){
 if(!secret||!/^sha256=[a-f0-9]{64}$/.test(signature||''))return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const bytes=Uint8Array.from(signature.slice(7).match(/../g),hex=>parseInt(hex,16));
 return crypto.subtle.verify('HMAC',key,bytes,raw);
}
export async function waReadBody(request,max=262144){
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();let size=0;const parts=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('too-large')}parts.push(value)}
 const raw=new Uint8Array(size);let offset=0;for(const part of parts){raw.set(part,offset);offset+=part.length}return raw;
}
