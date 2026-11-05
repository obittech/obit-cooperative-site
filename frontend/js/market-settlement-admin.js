for(const id of ['payoutVerification','settlementReview'])document.getElementById(id).addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target,button=form.querySelector('button'),out=document.getElementById(id+'Status');button.disabled=true;
 try{const token=OBIT.getSession('staff');if(!token)throw Error('Sign in as staff first.');
 if(id==='payoutVerification'){await OBIT.post(`/api/admin/market/sellers/${Number(form.elements.seller_id.value)}/payout-verification`,{evidence_reference:form.elements.evidence_reference.value,account_last_four:form.elements.account_last_four.value,identity_checked:form.elements.identity_checked.checked,payout_ownership_checked:form.elements.payout_ownership_checked.checked},{token});out.textContent='Verification recorded. Recheck the exact destination before settlement.';}
 else{const result=await OBIT.get(`/api/admin/market/orders/${Number(form.elements.order_id.value)}/settlement-review`,{token});out.textContent=result.blockers.length?'Settlement blockers: '+result.blockers.join(', '):'Checklist complete. '+result.note;}
 }catch(error){out.textContent=error.message;}finally{button.disabled=false;}
});
