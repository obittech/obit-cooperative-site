const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const elements=Object.fromEntries(['dobDay','dobMonth','dobYear','date_of_birth','dobError'].map(id=>[id,{id,value:'',handlers:{},addEventListener(k,f){this.handlers[k]=f;},setCustomValidity(v){this.validity=v;},removeAttribute(){},setAttribute(){},focus(){this.focused=true;},select(){},reportValidity(){}}]));
 const context={window:{},document:{getElementById:id=>elements[id]}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../frontend/js/dob.js'),'utf8'),context);
 context.window.ObitDOB.init();return {dob:context.window.ObitDOB,e:elements};
}
test('DOB converts day/month/year to API format and checks leap years and impossible dates',()=>{
 const {dob}=fixture(),now=new Date('2026-11-05T12:00:00Z');
 assert.equal(dob.isoDate('9','2','1985',now),'1985-02-09');
 assert.equal(dob.isoDate('29','02','2000',now),'2000-02-29');
 for(const parts of [['29','02','1900'],['31','04','1985'],['00','01','1985'],['01','13','1985'],['5','11','2026'],['6','11','2026'],['1','1','85']])assert.equal(dob.isoDate(...parts,now),'');
});
test('restoring an application fills all three boxes and preserves the ISO payload',()=>{
 const {dob,e}=fixture();e.date_of_birth.value='1985-09-24';dob.restore();
 assert.equal(e.dobDay.value,'24');assert.equal(e.dobMonth.value,'09');assert.equal(e.dobYear.value,'1985');assert.equal(dob.validate(),true);assert.equal(e.date_of_birth.value,'1985-09-24');
});
test('input moves to the next box, supports backspace, and rejects invalid dates before submission',()=>{
 const {dob,e}=fixture();e.dobDay.value='24';e.dobDay.handlers.input({inputType:'insertText'});assert.equal(e.dobMonth.focused,true);
 e.dobMonth.handlers.keydown({key:'Backspace'});assert.equal(e.dobDay.focused,true);
 e.dobMonth.value='02';e.dobYear.value='1985';e.dobDay.value='31';assert.equal(dob.validate(),false);assert.equal(e.date_of_birth.value,'');assert.ok(e.dobError.textContent.includes('real date'));
});
test('pasting a complete day/month/year date fills each box',()=>{
 const {dob,e}=fixture();let prevented=false;e.dobDay.handlers.paste({clipboardData:{getData:()=> '24/09/1985'},preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(dob.validate(),true);assert.equal(e.date_of_birth.value,'1985-09-24');
});
