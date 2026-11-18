// Real Chromium responsive UI regression; synthetic API responses, never production.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../frontend');
 const server=createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch();fs.mkdirSync('browser-artifacts',{recursive:true});
 try{for(const width of [320,375,430,1280]){
 const page=await browser.newPage({viewport:{width,height:900}});let support='',expired=false,saves=0;
 await page.route('**/js/config.js',r=>r.fulfill({contentType:'text/javascript',body:`window.OBIT_API_BASE=${JSON.stringify(base)};`}));
 await page.route('**/api/**',async r=>{const req=r.request(),url=req.url();let data,status=200;
 if(url.endsWith('/resume'))data={application_id:30,application_token:'app.synthetic.test'};
 else if(expired){status=401;data={error:'Session expired. Sign in again.'};}
 else {assert.equal(req.headers().authorization,'Bearer app.synthetic.test');if(url.endsWith('/support')){support=req.postDataJSON().message;saves++;data={saved:true};}else data={application:{id:30,full_legal_name:'Synthetic Applicant',email:'synthetic@example.invalid',phone:'000'},identity_status:'KYC_PENDING',payment_status:'NOT_RECORDED',support_request:{message:support}};}
 await r.fulfill({status,json:data});});
 await page.goto(base+'/application-portal.html');
 assert.ok(await page.locator('#login').isVisible());
 await page.locator('#username').fill('synthetic');await page.locator('#password').fill('synthetic-password');await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.locator('#account').waitFor({state:'visible'});assert.equal(await page.locator('#password').inputValue(),'');assert.match(await page.locator('#details').innerText(),/KYC_PENDING/);
 await page.locator('#message').fill('Please reconcile the existing payment.');await page.getByRole('button',{name:'Save support request'}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Support request saved'));assert.equal(saves,1);
 await page.reload();await page.locator('#account').waitFor({state:'visible'});assert.equal(await page.locator('#message').inputValue(),support);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+width);
 await page.screenshot({path:`browser-artifacts/limited-portal-${width}.png`,fullPage:true});
 expired=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>sessionStorage.getItem('obit_application_token')),null);
 expired=false;await page.locator('#password').fill('synthetic-password');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.locator('#account').waitFor({state:'visible'});await page.getByRole('button',{name:'Log out',exact:true}).click();assert.equal(await page.locator('#account').isVisible(),false);assert.equal(await page.locator('#message').inputValue(),'');
 await page.getByRole('link',{name:'Back to application',exact:true}).click();assert.ok(page.url().endsWith('/apply.html'));await page.goBack();await page.locator('#login').waitFor({state:'visible'});await page.close();console.log('PASS Chromium width '+width);
 }}finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
