// Shopping identities are independent of cooperative membership sessions.
const MarketCommerce=(()=>{
 const SESSION='obit_market_buyer_session',GUEST='obit_market_bag_v1';let profile=null;
 function read(){try{return sessionStorage.getItem(SESSION)||'';}catch{return '';}}
 function clear(){try{sessionStorage.removeItem(SESSION);}catch{}profile=null;}
 async function call(method,path,body){
  const token=read(),headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
  const res=await fetch(window.OBIT_API_BASE+path,{method,headers,signal:AbortSignal.timeout(15000),body:body===undefined?undefined:JSON.stringify(body)});
  let data;try{data=await res.json();}catch{throw Error('The service did not respond. Please try again.');}
  if(!res.ok){if(res.status===401){clear();document.dispatchEvent(new Event('market:signout'));}throw Error(data.error||'Please try again.');}
  return data;
 }
 function guest(){try{return ObitMarketState.normalize(JSON.parse(localStorage.getItem(GUEST)||'[]'));}catch{return [];}}
 async function initialise(){
  if(!read())return null;
  const result=await call('GET','/api/market/buyer/me');profile=result;
  return result;
 }
 async function connectGuest(){
  const local=guest();
  const result=local.length?await call('POST','/api/market/cart/merge',{items:local}):await call('GET','/api/market/cart');
  if(local.length){try{if(result.skipped_items?.length)localStorage.setItem(GUEST,JSON.stringify(result.skipped_items));else localStorage.removeItem(GUEST);}catch{}}
  return result;
 }
 return {call,guest,clear,initialise,connectGuest,signedIn:()=>!!profile&&!!read(),profile:()=>profile,
  async verify(challenge,code){const result=await call('POST','/api/market/buyer/verify-code',{challenge,code});sessionStorage.setItem(SESSION,result.token);return initialise();},
  async logout(){await call('POST','/api/market/buyer/logout',{});clear();document.dispatchEvent(new Event('market:signout'));},
  async saveAddress(address){const result=await call('POST','/api/market/buyer/address',address);profile.address=result;return result;},
  async cart(){return call('GET','/api/market/cart');},
  async change(id,qty){return call('POST','/api/market/cart/item',{id,qty});},
  async preview(items){return call('POST','/api/market/cart-preview',{items});}
 };
})();
