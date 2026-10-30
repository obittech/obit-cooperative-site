const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function render(bankPayment,available=true){
 const nodes=new Map();const node=()=>({innerHTML:'',textContent:'',addEventListener(){},querySelectorAll(){return []},reset(){},close(){}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)},querySelector(){return node()},addEventListener(){}};
 const o={id:1,reference:'OBM-TEST',seller_id:1,status:bankPayment?.status==='CONFIRMED'?'PAID':bankPayment?.status==='CLAIMED'?'PAYMENT_PENDING':'AWAITING_PAYMENT',bank_payment:bankPayment,destination:{city:'Abuja',state:'FCT'},items:[],events:[],total_kobo:123450,subtotal_kobo:123450,delivery_kobo:0};
 const ctx={document,MarketCommerce:{signedIn:()=>true,call:async(_m,path)=>path.endsWith('/capabilities')?{bank_transfer_available:available}:[o]},DeliveryUI:{bind(){},card(){return ''}},URL,console};vm.createContext(ctx);vm.runInContext(fs.readFileSync('frontend/js/market-orders.js','utf8')+'\nglobalThis.ui=OrderUI;',ctx);await ctx.ui.refresh();return nodes.get('buyerOrders').innerHTML;
}
test('checkout renders transfer details without uploads and keeps notification pending',async()=>{
 const base={amount_kobo:123450,bank_name:'Test Bank',account_name:'Test Company',account_number:'0123456789'};
 const ready=await render({...base,status:'READY'});assert.match(ready,/I Have Paid/);assert.match(ready,/0123456789/);assert.doesNotMatch(ready,/type="file"/);
 const pending=await render({...base,status:'CLAIMED'});assert.match(pending,/Payment awaiting confirmation/);assert.match(pending,/wa.me\/2348030567787/);
 const paid=await render({...base,status:'CONFIRMED',confirmed_ms:Date.now(),receipt_reference:'OBMR-TEST'});assert.match(paid,/OBMR-TEST/);assert.match(paid,/Print \/ save receipt/);
 const off=await render(null,false);assert.match(off,/data-bank-start="1" disabled/);
});
