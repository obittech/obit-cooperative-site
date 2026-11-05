import {all,get,run} from '../db.js';
import {HttpError} from '../router.js';
export const SAVINGS_TYPES=['General Savings','Emergency Fund','Business Capital','Rent','School Fees','Equipment','Vehicle','Housing'];
export const EQUIPMENT={
 'Tailoring & Fashion':['Sewing machine','Industrial sewing machine','Overlock machine','Embroidery machine','Steam iron'],
 'Food & Catering':['Gas cooker','Commercial oven','Mixer','Freezer','Food processor'],
 'Salon & Beauty':['Hair dryer','Salon chair','Hair steamer','Steriliser','Barber clipper set'],
 'Retail & Trading':['Display shelves','Freezer','Refrigerator','Weighing scale'],
 'Agriculture':['Irrigation pump','Feed mill','Incubator','Cassava processing machine','Tractor'],
 'Printing & Office':['Laptop','Desktop computer','Printer','Photocopier','Large format printer'],
 'Welding & Fabrication':['Welding machine','Cutting machine','Angle grinder','Air compressor'],
 'Carpentry & Furniture':['Circular saw','Planer','Drill press','Sanding machine'],
 'Laundry':['Washing machine','Dryer','Steam press'],
 'Transport & Logistics':['Delivery motorcycle','Tricycle','Delivery van'],
 'Power & Solar':['Solar panels and inverter','Battery storage system','Generator'],
 'Other Business':['Other equipment']
};
export function maturity(start,months){const d=new Date(start),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.getTime();}
export async function planBalance(id){const r=await get(`SELECT COALESCE(SUM(CASE WHEN f.kind='DEPOSIT' AND f.status='CONFIRMED' THEN f.amount_kobo WHEN f.kind='WITHDRAWAL' AND f.status IN ('REPORTED','PAID') THEN -f.amount_kobo ELSE 0 END),0) AS n FROM savings_request_terms t JOIN member_finance_requests f ON f.id=t.request_id WHERE t.plan_id=?`,[id]);return Number(r.n);}
export async function ownedPlan(member,id){const p=await get(`SELECT p.*,t.lock_months,t.business_type,t.equipment,t.started_ms,t.maturity_ms FROM contribution_plans p JOIN savings_plan_terms t ON t.plan_id=p.id WHERE p.id=? AND p.member_id=? AND p.status!='CLOSED'`,[id,member]);if(!p)throw new HttpError(400,'Choose one of your current savings plans with a lock period');return p;}
export async function plans(member){const rows=await all(`SELECT p.*,t.lock_months,t.business_type,t.equipment,t.started_ms,t.maturity_ms FROM contribution_plans p LEFT JOIN savings_plan_terms t ON t.plan_id=p.id WHERE p.member_id=? ORDER BY p.id DESC`,[member]);for(const p of rows){const saved=await planBalance(p.id),target=Number(p.target_amount_kobo||Math.round(Number(p.target_amount||0)*100));const loan=await get('SELECT reference,status FROM equipment_loan_requests WHERE plan_id=?',[p.id]);Object.assign(p,{available_kobo:saved,savings_percent:target>0?Math.min(100,saved/target*100):0,loan_eligible:!!p.lock_months&&p.status!=='CLOSED'&&p.purpose==='Equipment'&&target>0&&saved>=Math.ceil(target/2)&&saved<target&&!loan,loan_request:loan||null});}return rows;}
export async function validateAllocation(member,b,amount){const p=await ownedPlan(member,Number(b.plan_id));if(b.kind==='WITHDRAWAL'){if(b.accept_fee!==true)throw new HttpError(400,'Accept the 10% withdrawal charge');if(!p.maturity_ms||Date.now()<Number(p.maturity_ms))throw new HttpError(409,'This savings plan is locked until its maturity date');if(await get('SELECT id FROM equipment_loan_requests WHERE plan_id=?',[p.id]))throw new HttpError(409,'This equipment plan has a loan request. Contact Obit before withdrawing');if(amount>await planBalance(p.id))throw new HttpError(409,'Amount exceeds the available savings in this plan');}return p;}
export async function allocateRequest(r,p){const fee=r.kind==='WITHDRAWAL'?Math.round(Number(r.amount_kobo)*0.1):0;await run('INSERT INTO savings_request_terms (request_id,plan_id,fee_kobo,payout_kobo) VALUES (?,?,?,?) RETURNING request_id AS id',[r.id,p.id,fee,Number(r.amount_kobo)-fee]);}
export async function startPlan(r){if(r.kind!=='DEPOSIT')return;const t=await get('SELECT t.* FROM savings_plan_terms t JOIN savings_request_terms r ON r.plan_id=t.plan_id WHERE r.request_id=?',[r.id]);if(t&&!t.started_ms){const now=Date.now();await run('UPDATE savings_plan_terms SET started_ms=?,maturity_ms=? WHERE plan_id=? AND started_ms IS NULL',[now,maturity(now,Number(t.lock_months)),t.plan_id]);}}
