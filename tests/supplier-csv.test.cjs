const test=require('node:test'),assert=require('node:assert/strict'),csv=require('../frontend/js/supplier-csv.js');
const product={source_key:'solar-1',supplier:'Distributor',source_url:'https://supplier.example/product',title:'Inverter, 24V',description:'Exact model\nIncludes manual',cost_kobo:8000000,quantity:5,category:'Solar & Power',delivery_days:7,seller_member_id:2};
test('supplier CSV roundtrips commas, newlines, quotes and Naira costs',()=>{
 const p=csv.parse('\uFEFF'+csv.stringify([{...product,title:'24V "Home", inverter'}]))[0];assert.equal(p.title,'24V "Home", inverter');assert.equal(p.description,product.description);assert.equal(p.cost_kobo,8000000);assert.equal(p.quantity,5);assert.equal(p.delivery_days,7);assert.equal(p.markup_bps,3000);assert.equal(p.handling_kobo,0);
 assert.equal(p.supply_confirmed,false);assert.equal(p.content_authorised,false);assert.equal(p.checked_ms,0);
});
test('missing costs remain unknown and absent quantities are not invented',()=>{
 const p=csv.parse(csv.stringify([{...product,cost_kobo:null,quantity:null}]))[0];assert.equal(p.cost_kobo,null);assert.equal(p.quantity,0);
});
test('malformed quoting and inconsistent columns fail before import',()=>{
 assert.throws(()=>csv.parse('source_key,supplier,source_url,title,description\n"unclosed'));
 assert.throws(()=>csv.parse('source_key,supplier,source_url,title,description\na,b,c,d'));
 assert.throws(()=>csv.parse('source_key,supplier,source_url,title,description\n"a"bad,b,c,d,e'));
});
test('duplicate identifiers, oversized batches and absent mandatory fields are rejected',()=>{
 assert.throws(()=>csv.parse(csv.stringify([product,product])),/Duplicate/);
 assert.throws(()=>csv.parse(csv.stringify(Array.from({length:101},(_,i)=>({...product,source_key:String(i)})))));
 assert.throws(()=>csv.parse('title,description\na,b'),/Missing column/);
 assert.throws(()=>csv.parse(csv.stringify([{...product,supplier:''}])));
});
test('fractional or negative stock and malformed monetary values are rejected',()=>{
 for(const quantity of [-1,1.5,100001])assert.throws(()=>csv.parse(csv.stringify([{...product,quantity}])));
 const s=csv.stringify([product]);for(const cost of ['-1','NaN','12.345','0'])assert.throws(()=>csv.parse(s.replace('80000.00',cost)));
});
test('CSV export neutralises spreadsheet formula prefixes including whitespace',()=>{
 for(const title of ['=HYPERLINK("https://example.com")','+cmd','-cmd','@SUM(A1)','  =1+1']){const result=csv.stringify([{...product,title}]);assert.ok(result.includes('"\''));}
});
