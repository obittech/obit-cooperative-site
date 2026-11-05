(function(root){
'use strict';
const money=kobo=>new Intl.NumberFormat('en-NG',{style:'currency',currency:'NGN'}).format(kobo/100);
function quote(product,quantity,location){
 const qty=Number(quantity),town=String(location||'').trim();
 if(!Number.isInteger(qty)||qty<1||qty>100)throw Error('Choose a whole quantity from 1 to 100.');
 if(town.length<2||town.length>120)throw Error('Enter your delivery town and state (2 to 120 characters).');
 if(!Number.isSafeInteger(product.priceKobo)||product.priceKobo<=0||!Number.isSafeInteger(product.priceKobo*qty))throw Error('This price needs to be checked with Obit.');
 const subtotal=product.priceKobo*qty;
 const text=`Hello Obit, please confirm this purchase request.\nProduct: ${product.title}\nQuantity: ${qty}\nDisplayed unit price: ${money(product.priceKobo)}\nProduct subtotal: ${money(subtotal)}\nDelivery town/state: ${town}\nDelivery fee: awaiting quote, separate from product subtotal.\nPlease confirm availability, delivery fee, delivery time and final total before I pay.\n${product.stock}\nThis is an unpaid request.`;
 return {subtotal,text,url:'https://wa.me/2348030567787?text='+encodeURIComponent(text)};
}
if(typeof module==='object'&&module.exports)module.exports={quote,money};
if(!root.document)return;
const dialog=document.getElementById('sourceOrderDialog');if(!dialog)return;
const form=document.getElementById('sourceOrderForm'),quantity=document.getElementById('sourceOrderQuantity'),location=document.getElementById('sourceOrderLocation'),draft=document.getElementById('sourceOrderDraft'),send=document.getElementById('sourceOrderWhatsApp'),review=document.getElementById('sourceOrderReview'),error=document.getElementById('sourceOrderError');let product;
function invalidate(){review.hidden=true;send.removeAttribute('href');draft.value='';error.textContent='';if(product){const n=Number(quantity.value);document.getElementById('sourceOrderSubtotal').textContent=Number.isInteger(n)&&n>=1&&n<=100?money(product.priceKobo*n):'Choose quantity';}}
for(const card of document.querySelectorAll('[data-source-product]')){
 const link=card.querySelector('.source-enquire');link.textContent='View & request';link.setAttribute('aria-label','View and request '+card.querySelector('h3').textContent);
 link.addEventListener('click',event=>{event.preventDefault();product={title:card.querySelector('h3').textContent,priceKobo:Number(card.dataset.priceKobo),stock:card.querySelector('.source-stock').textContent};form.reset();document.getElementById('sourceOrderTitle').textContent=product.title;document.getElementById('sourceOrderPrice').textContent=money(product.priceKobo);document.getElementById('sourceOrderStock').textContent=product.stock;const image=document.getElementById('sourceOrderImage');image.src=card.querySelector('img').getAttribute('src');image.alt=product.title;invalidate();dialog.showModal();});
}
quantity.addEventListener('input',invalidate);location.addEventListener('input',invalidate);
form.addEventListener('submit',event=>{event.preventDefault();invalidate();try{const result=quote(product,quantity.value,location.value);draft.value=result.text;send.href=result.url;review.hidden=false;send.focus();}catch(err){error.textContent=err.message;}});
document.getElementById('closeSourceOrder').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>{form.reset();invalidate();});
})(typeof window!=='undefined'?window:{});
