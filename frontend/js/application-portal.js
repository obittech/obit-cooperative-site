let applicationId=sessionStorage.getItem('obit_limited_application_id');
let generation=0;
const notice=document.getElementById('notice');
function clearLimitedSession(){generation++;applicationId=null;sessionStorage.removeItem('obit_limited_application_id');OBIT.clearSession('application');document.getElementById('account').hidden=true;document.getElementById('login').hidden=false;document.getElementById('details').replaceChildren();document.getElementById('message').value='';}
async function loadLimitedAccount(){
 const current=generation,id=applicationId;
 const d=await OBIT.get(`/api/applications/${id}/limited-portal`);
 if(current!==generation||id!==applicationId)return;
 const details=document.getElementById('details');details.replaceChildren();
 for(const [label,value] of Object.entries({'Application':d.application.id,'Name':d.application.full_legal_name,'Email':d.application.email,'Phone':d.application.phone,'Access':'Limited applicant, not active membership','KYC':d.identity_status,'Payment record':d.payment_status})){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value||'Not recorded';details.append(dt,dd);}
 document.getElementById('message').value=d.support_request?.message||'';
 document.getElementById('login').hidden=true;document.getElementById('account').hidden=false;
 notice.textContent='Signed in with limited access. Your KYC and payment statuses have not been changed.';
}
document.getElementById('login').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');if(b.disabled)return;b.disabled=true;const current=++generation;try{const s=await OBIT.post('/api/applications/resume',{username:document.getElementById('username').value,password:document.getElementById('password').value});if(current!==generation)return;OBIT.saveSession('application',s.application_token);applicationId=String(s.application_id);sessionStorage.setItem('obit_limited_application_id',applicationId);await loadLimitedAccount();}catch(err){clearLimitedSession();notice.textContent=err.message;}finally{document.getElementById('password').value='';b.disabled=false;}};
document.getElementById('support').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');if(b.disabled)return;b.disabled=true;const current=generation;try{await OBIT.post(`/api/applications/${applicationId}/limited-portal/support`,{message:document.getElementById('message').value});if(current===generation)notice.textContent='Support request saved for staff. No payment or identity status changed.';}catch(err){if(current===generation)notice.textContent=err.message;}finally{b.disabled=false;}};
document.getElementById('logout').onclick=()=>{clearLimitedSession();notice.textContent='Logged out.';};
document.getElementById('refresh').onclick=()=>loadLimitedAccount().catch(err=>{clearLimitedSession();notice.textContent=err.message;});
if(applicationId&&OBIT.getSession('application'))loadLimitedAccount().catch(err=>{clearLimitedSession();notice.textContent=err.message;});
