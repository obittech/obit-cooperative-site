(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ObitSupplierCSV=api;})(typeof window==='undefined'?this:window,function(){
 const headers=['source_key','supplier','source_url','title','description','category','image_url','cost_naira','quantity','delivery_days','seller_member_id'];
 function parse(source){
  if(typeof source!=='string'||source.length>2000000)throw Error('Use a CSV file smaller than 2 MB.');
  source=source.replace(/^\uFEFF/,'');let rows=[],row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<source.length;i++){let c=source[i];if(quoted){if(c==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
   if(c==='"'){if(cell||closed)throw Error('Unexpected quote in CSV.');quoted=true;continue;}
   if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';closed=false;if(c!==','){if(c==='\r'&&source[i+1]==='\n')i++;if(row.some(v=>v!==''))rows.push(row);row=[];}continue;}
   if(closed)throw Error('Unexpected text after a quoted CSV value.');cell+=c;
  }
  if(quoted)throw Error('A quoted CSV value is not closed.');row.push(cell);if(row.some(v=>v!==''))rows.push(row);
  if(rows.length<2||rows.length>101)throw Error('Include a header and 1 to 100 products.');
  const keys=rows.shift().map(v=>v.trim());if(new Set(keys).size!==keys.length)throw Error('CSV headers must be unique.');
  for(const key of headers.slice(0,5))if(!keys.includes(key))throw Error('Missing column: '+key);
  const seen=new Set();return rows.map((values,index)=>{if(values.length!==keys.length)throw Error('Column count differs on product '+(index+1));
   const p=Object.fromEntries(keys.map((k,i)=>[k,values[i].trim()]));for(const key of headers.slice(0,5))if(!p[key])throw Error('Missing '+key+' on product '+(index+1));if(seen.has(p.source_key))throw Error('Duplicate source_key: '+p.source_key);seen.add(p.source_key);
   function integer(key,max,optional=false){const s=p[key]||'';if(optional&&!s)return null;if(!s)return 0;if(!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s))||Number(s)>max)throw Error('Invalid '+key+' on product '+(index+1));return Number(s);}
   const cost=p.cost_naira||'';if(cost&&!/^\d+(?:\.\d{1,2})?$/.test(cost))throw Error('Enter cost_naira with up to two decimal places.');const kobo=cost?Math.round(Number(cost)*100):null;if(kobo!==null&&(!Number.isSafeInteger(kobo)||kobo<1||kobo>300000000))throw Error('Supplier cost is outside the allowed range.');
   return {source_key:p.source_key,supplier:p.supplier,source_url:p.source_url,title:p.title,description:p.description,category:p.category||'Other',image_url:p.image_url||'',cost_kobo:kobo,handling_kobo:0,markup_bps:3000,quantity:integer('quantity',100000),delivery_days:integer('delivery_days',60,true),seller_member_id:integer('seller_member_id',Number.MAX_SAFE_INTEGER,true),supply_confirmed:false,content_authorised:false,checked_ms:0};
  });
 }
 function quote(value){let s=String(value??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
 function stringify(items){return headers.join(',')+'\r\n'+items.map(p=>headers.map(k=>quote(k==='cost_naira'?(p.cost_kobo==null?'':(Number(p.cost_kobo)/100).toFixed(2)):p[k])).join(',')).join('\r\n');}
 return {parse,stringify,headers};
});
