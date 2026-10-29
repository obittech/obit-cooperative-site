// Shared phone navigation; desktop sections remain visible.
const ObitMobile=(()=>{
 const account=document.getElementById('buyerAccount');
 const tabs=[...document.querySelectorAll('[data-account-view]')];
 function setAccountView(view,scroll=false){
  if(!account||!['bag','delivery','requests','orders'].includes(view))return;
  account.dataset.mobileView=view;
  for(const tab of tabs){const selected=tab.dataset.accountView===view;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
  if(scroll&&matchMedia('(max-width:768px)').matches)document.querySelector('.account-mobile-tabs')?.scrollIntoView({block:'start',behavior:'smooth'});
 }
 for(const [index,tab]of tabs.entries()){
  tab.addEventListener('click',()=>setAccountView(tab.dataset.accountView,true));
  tab.addEventListener('keydown',event=>{
   let target;if(event.key==='ArrowRight')target=(index+1)%tabs.length;if(event.key==='ArrowLeft')target=(index+tabs.length-1)%tabs.length;if(event.key==='Home')target=0;if(event.key==='End')target=tabs.length-1;
   if(target===undefined)return;event.preventDefault();tabs[target].focus();setAccountView(tabs[target].dataset.accountView);
  });
 }
 function hashView(){if(account)setAccountView(location.hash==='#orders'?'orders':location.hash==='#requests'?'requests':location.hash==='#delivery'?'delivery':'bag');}
 document.getElementById('editDeliveryFromBag')?.addEventListener('click',()=>{
  setAccountView('delivery',true);if(!matchMedia('(max-width:768px)').matches)document.getElementById('deliveryPanel').scrollIntoView({block:'start',behavior:'smooth'});
 });
 window.addEventListener('hashchange',hashView);hashView();
 document.getElementById('accountBagNav')?.addEventListener('click',()=>setAccountView('bag',true));
 const categorySelect=document.getElementById('mobileCategoryFilter');
 if(categorySelect){categorySelect.innerHTML=categories.map(c=>`<option>${c.replace(/&/g,'&amp;')}</option>`).join('');categorySelect.value=selectedCategory;categorySelect.addEventListener('change',()=>chooseCategory(categorySelect.value));}
 const toggle=document.getElementById('mobileFilterToggle'),filters=document.getElementById('marketFilters');
 function closeFilters(){if(!toggle)return;toggle.setAttribute('aria-expanded','false');filters.dataset.mobileOpen='false';}
 toggle?.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));filters.dataset.mobileOpen=String(open);});
 document.getElementById('closeMobileFilters')?.addEventListener('click',()=>{closeFilters();document.getElementById('shop').scrollIntoView({block:'start',behavior:'smooth'});});
 document.getElementById('globalSearch')?.addEventListener('submit',closeFilters);
 document.getElementById('mobileRefresh')?.addEventListener('click',()=>document.getElementById('btnRefresh').click());
 document.getElementById('mobileSaved')?.addEventListener('click',()=>document.getElementById('wishlistButton').click());
 return {setAccountView};
})();
