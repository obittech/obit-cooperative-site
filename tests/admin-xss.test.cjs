const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup(apps) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {style:{},innerHTML:'',addEventListener(){},querySelectorAll(){return [];}});
    return nodes.get(id);
  };
  const ctx = vm.createContext({document:{getElementById:node,querySelectorAll:()=>[]},OBIT:{getSession:()=>null,get:async()=>apps}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/js/admin.js'),'utf8'),ctx);
  vm.runInContext('refreshMembershipTransfers = async () => {}; refreshReferralBonuses = async () => {};',ctx);
  return {ctx,node};
}
test('application queue renders hostile applicant data as text and preserves review controls',async()=>{
  const {ctx,node} = setup([{id:7,full_legal_name:'<img src=x onerror="alert(1)"> O\'Brien & Sons',status:'UNDER_REVIEW',updated_at:'<svg onload=alert(2)>'}]);
  await ctx.refreshQueue('test-only');
  const html=node('queueBody').innerHTML;
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('<svg'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; O&#39;Brien &amp; Sons'));
  assert.ok(html.includes('data-decide="7" data-decision="APPROVE"'));
  assert.ok(html.includes('UNDER_REVIEW'));
});
test('queue identifiers cannot escape attributes; badge and error strings are escaped',async()=>{
  const {ctx,node} = setup([{id:'" onclick="alert(1)',full_legal_name:'Normal Name',status:'UNDER_REVIEW',updated_at:'2026-11-10'}]);
  await ctx.refreshQueue('test-only');
  assert.ok(!node('queueBody').innerHTML.includes('data-decide="" onclick='));
  assert.ok(node('queueBody').innerHTML.includes('data-decide="&quot; onclick=&quot;alert(1)"'));
  assert.ok(!ctx.badge('<script>alert(1)</script>').includes('<script>'));
  ctx.showAlert('<img src=x onerror=alert(1)>','" onclick="alert(2)');
  assert.equal(node('alertBox').innerHTML,'<div class="alert alert-error">&lt;img src=x onerror=alert(1)&gt;</div>');
});
test('empty queue and missing applicant name still render normally',async()=>{
  const empty=setup([]);await empty.ctx.refreshQueue('test');assert.match(empty.node('queueBody').innerHTML,/No applications yet/);
  const missing=setup([{id:8,status:'ACTIVE',updated_at:'2026-11-10'}]);await missing.ctx.refreshQueue('test');assert.match(missing.node('queueBody').innerHTML,/<td>—<\/td>/);
});
