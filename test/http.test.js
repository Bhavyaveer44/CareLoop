'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {app,store,clock,processWebhook,ensureToday,sweep,dataGapReason,seedUsers}=require('../src/server');
const {ringDataGapReason}=require('../src/domain');
const {atLocalTime}=require('../src/clock');

let server,base;
test.before(async()=>{server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));});
function token(id){return seedUsers.find(user=>user.id===id).testToken;}
async function request(path,{user='priya',headers={},method='GET',body,raw}={}) {
  const options={method,headers:{...headers}};
  if(user)options.headers.Authorization=`Bearer ${token(user)}`;
  if(raw!==undefined){options.body=raw;options.headers['Content-Type']='application/json';}
  else if(body!==undefined){options.body=JSON.stringify(body);options.headers['Content-Type']='application/json';}
  const response=await fetch(`${base}${path}`,options);let result={};try{result=await response.json();}catch{}return {response,result};
}
function sign(raw){return 'sha256='+crypto.createHmac('sha256','careloop-local-demo-webhook-secret').update(raw).digest('hex');}
function cleanForDay(){store.mutate(state=>{state.alerts=[];state.events=[];state.notifications=[];state.confirmations={};state.household.sharingPaused=false;state.household.motionEnabled=true;state.household.deviceOnline=true;state.household.ringHealth={ok:true,lastSyncAt:null,error:null,motionEnabled:true,country:'US'};});}

test('all three frontend pages and assets render; UI contains no seeded bearer tokens',async()=>{
  for(const path of ['/caregiver','/recipient','/sources']){const response=await fetch(base+path);assert.equal(response.status,200);const html=await response.text();assert.match(html,/CareLoop/);assert.match(html,/\/app.js/);}
  const script=await (await fetch(base+'/app.js')).text();assert.doesNotMatch(script,/careloop-demo-(?:priya|arjun|margaret)-token/);assert.match(script,/\/api\/demo\/scenario/);
  const css=await (await fetch(base+'/style.css')).text();assert.match(css,/prefers-reduced-motion/);assert.match(css,/focus-visible/);
});

test('page session authenticates without exposing bearer token in UI',async()=>{
  const page=await fetch(base+'/caregiver');const cookie=page.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/household',{headers:{Cookie:cookie}});assert.equal(response.status,200);
  assert.equal((await response.json()).household.tz,'America/New_York');
});

test('bearer auth is generic and caregiver alert/timeline reads are access logged',async()=>{
  const unauthorized=await fetch(base+'/api/alerts');assert.equal(unauthorized.status,401);assert.deepEqual(await unauthorized.json(),{error:'UNAUTHORIZED'});
  await request('/api/alerts');await request('/api/timeline');
  const logs=store.get().accessLog.filter(entry=>entry.caregiverId==='priya');assert.ok(logs.some(entry=>entry.resource==='alerts'));assert.ok(logs.some(entry=>entry.resource==='timeline'));
});

test('required API routes respond with role checks and memory-only Ring token',async()=>{
  assert.equal((await request('/api/clock')).response.status,200);
  assert.equal((await request('/api/clock',{method:'POST',body:{speed:1.5}})).response.status,200);
  const ringToken=await request('/api/ring/token',{user:'margaret',method:'POST',body:{accessToken:'demo-access-token'}});assert.equal(ringToken.response.status,200);assert.equal(ringToken.result.stored,'memory_only');assert.equal(JSON.stringify(store.get()).includes('demo-access-token'),false);
  const originalRefresh=process.env.RING_REFRESH_TOKEN;process.env.RING_REFRESH_TOKEN='known-refresh-only';const rejectedRefresh=await request('/api/ring/token',{user:'margaret',method:'POST',body:{accessToken:'known-refresh-only'}});assert.equal(rejectedRefresh.response.status,400);if(originalRefresh===undefined)delete process.env.RING_REFRESH_TOKEN;else process.env.RING_REFRESH_TOKEN=originalRefresh;
  for(const route of ['/api/household','/api/alerts','/api/timeline','/api/sources'])assert.ok((await request(route)).response.status<500);
  cleanForDay();assert.equal((await request('/api/recipient/pause',{user:'margaret',method:'POST',body:{paused:true}})).response.status,200);
  const before=store.get().notifications.filter(item=>item.userId==='priya').length;const helpWhilePaused=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'help'}});assert.equal(helpWhilePaused.response.status,200);assert.equal(store.get().notifications.filter(item=>item.userId==='priya').length,before);assert.ok(store.get().audit.some(entry=>entry.action==='caregiver_notification_skipped'&&entry.reason==='sharing_paused'));
  assert.equal((await request('/api/alerts',{user:'priya'})).response.status,403);
  await request('/api/recipient/pause',{user:'margaret',method:'POST',body:{paused:false}});cleanForDay();
  assert.equal((await request('/api/household/consents',{user:'margaret'})).response.status,200);
  assert.equal((await request('/api/household/consents',{user:'margaret',method:'POST',body:{caregiverId:'arjun',approved:false}})).response.status,200);
  assert.equal((await request('/api/alerts',{user:'arjun'})).response.status,403);
  await request('/api/household/consents',{user:'margaret',method:'POST',body:{caregiverId:'arjun',approved:true}});
});

test('raw webhook bad signature returns 401; valid unknown type returns 200, is audited and deduped',async()=>{
  const payload={meta:{version:'1.1',time:+clock.now(),request_id:'http-unknown',account_id:'demo'},data:{id:'http-unknown-event',type:'made_up_type',attributes:{source:'fixture-device',timestamp:+clock.now()}}};const raw=JSON.stringify(payload);
  const bad=await request('/ring/webhook',{user:null,method:'POST',raw,headers:{'X-Signature':'sha256='+'0'.repeat(64)}});assert.equal(bad.response.status,401);
  const good=await request('/ring/webhook',{user:null,method:'POST',raw,headers:{'X-Signature':sign(raw)}});assert.equal(good.response.status,200);
  await new Promise(resolve=>setImmediate(resolve));assert.ok(store.get().audit.some(entry=>entry.action==='webhook_received'&&entry.type==='made_up_type'));
  const duplicate=processWebhook(payload,'webhook');assert.equal(duplicate.duplicate,true);const unknownEvents=store.get().events.filter(event=>event.id==='http-unknown-event');assert.equal(unknownEvents.length,1);assert.equal(unknownEvents[0].type,'unknown');
});

test('signed simulator events can use the actual webhook receiver and keep simulated provenance',async()=>{
  const payload={meta:{request_id:'webhook-simulator-flow'},data:{id:'webhook-simulator-flow',type:'motion_detected',attributes:{timestamp:+clock.now(),sub_type:'human'}}};const raw=JSON.stringify(payload);
  const result=await request('/ring/webhook',{user:null,method:'POST',raw,headers:{'X-Signature':sign(raw),'X-CareLoop-Source':'simulated'}});assert.equal(result.response.status,200);await new Promise(resolve=>setImmediate(resolve));
  const event=store.get().events.find(item=>item.id==='webhook-simulator-flow');assert.equal(event.type,'motion');assert.equal(event.subType,'human');assert.equal(event.source,'simulated');
});

test('known simulated vehicle, animal and other motion events retain their event subtype',()=>{
  for(const subtype of ['vehicle','animal','other_motion']){const result=processWebhook({meta:{request_id:`known-${subtype}`},data:{id:`known-${subtype}`,type:'motion_detected',attributes:{timestamp:+clock.now(),sub_type:subtype}}},'simulated');assert.equal(result.event.type,'motion');assert.equal(result.event.subType,subtype);assert.equal(result.known,true);}
});

test('webhook and simulator event processing order by event timestamps and preserve source labels',async()=>{
  const future=+clock.now()+30000,older=+clock.now()+10000;
  const p1={meta:{request_id:'order-future'},data:{id:'order-future',type:'motion_detected',attributes:{source:'d',timestamp:future,sub_type:'human'}}};
  const p2={meta:{request_id:'order-older'},data:{id:'order-older',type:'button_press',attributes:{source:'d',timestamp:older}}};
  processWebhook(p1,'webhook');processWebhook(p2,'simulated');
  const events=store.get().events.filter(event=>event.id.startsWith('order-'));assert.equal(events[0].id,'order-future');assert.equal(events.find(event=>event.id==='order-future').source,'webhook');assert.equal(events.find(event=>event.id==='order-older').source,'simulated');
  const signedPayload={meta:{request_id:'sim-signed'},data:{id:'sim-signed',type:'motion_detected',attributes:{source:'d',timestamp:+clock.now(),sub_type:'vehicle'}}};const raw=JSON.stringify(signedPayload);
  const response=await request('/api/simulate/event',{user:null,method:'POST',raw,headers:{'X-Signature':sign(raw)}});assert.equal(response.response.status,200);await new Promise(resolve=>setImmediate(resolve));assert.equal(store.get().events.find(event=>event.id==='sim-signed').source,'simulated');
});

test('device offline is a data gap until a later online webhook',()=>{
  cleanForDay();const now=+clock.now();
  processWebhook({meta:{request_id:'offline-case'},data:{id:'offline-case',type:'device_offline',attributes:{source:'d',timestamp:now}}},'webhook');assert.match(dataGapReason(),/offline/);
  processWebhook({meta:{request_id:'online-case'},data:{id:'online-case',type:'device_online',attributes:{source:'d',timestamp:now+1}}},'webhook');assert.equal(dataGapReason(),null);
});

test('existing daily alert is merged to UNVERIFIABLE for authorization, disabled motion, and app removal',()=>{
  cleanForDay();let alert=ensureToday({force:true});
  store.mutate(state=>{state.household.ringHealth={...state.household.ringHealth,ok:false,error:'TOKEN_INVALID'};});
  alert=ensureToday({force:true});assert.equal(alert.decision,'UNVERIFIABLE');assert.match(alert.reason,/authorization/);
  cleanForDay();store.mutate(state=>{state.household.motionEnabled=false;state.household.ringHealth.motionEnabled=false;});alert=ensureToday({force:true});assert.equal(alert.decision,'UNVERIFIABLE');assert.match(alert.reason,/disabled/);
  cleanForDay();alert=ensureToday({force:true});processWebhook({meta:{request_id:'integration-removed'},data:{id:'integration-removed',type:'app_integration_removed',attributes:{timestamp:+clock.now()}}},'webhook');alert=store.get().alerts.find(item=>item.id===alert.id);assert.equal(alert.decision,'UNVERIFIABLE');
});

test('daily alert is unique by household and local date',()=>{
  cleanForDay();const first=ensureToday({force:true}),second=ensureToday({force:true});assert.equal(first.id,second.id);assert.equal(store.get().alerts.filter(item=>item.dailyKey===first.dailyKey).length,1);assert.match(first.dailyKey,/^household#\d{4}-\d{2}-\d{2}$/);
});

test('08:00 prompt, 09:30 reminder, 10:00 cutoff and 60-minute activity promotion use household time',()=>{
  const date=new Date('2026-10-20T12:00:00Z');const setLocal=(time,extra=0)=>{const target=+atLocalTime(date,'America/New_York',time)+extra;clock.configure({offsetMs:target-Date.now(),speed:1});};
  cleanForDay();setLocal('08:00',1000);let alert=ensureToday();assert.equal(alert.decision,'MORNING_CHECK');assert.equal(alert.dailyKey,'household#2026-10-20');
  setLocal('09:30',1000);sweep();alert=store.get().alerts.find(item=>item.id===alert.id);assert.ok(alert.reminderSentAt);assert.ok(store.get().notifications.some(item=>item.kind==='reminder'));
  setLocal('10:00',1000);sweep();alert=store.get().alerts.find(item=>item.id===alert.id);assert.equal(alert.decision,'UNCONFIRMED');assert.equal(alert.task,true);assert.equal(+new Date(alert.ackDeadlineAt)-+clock.now()<=300000,true);
  cleanForDay();setLocal('10:01',1000);store.mutate(state=>state.events=[{id:'possible-human',deviceId:'fixture-doorbell',type:'motion',subType:'human',ts:clock.now().toISOString(),source:'fixture'}]);alert=ensureToday();assert.equal(alert.decision,'POSSIBLE_ACTIVITY');assert.equal(alert.secondPrompt,true);assert.equal(alert.task,false);assert.ok(store.get().notifications.some(item=>item.kind==='second_prompt'));
  const promote=+new Date(alert.promoteAt);clock.configure({offsetMs:promote+1000-Date.now(),speed:1});sweep();alert=store.get().alerts.find(item=>item.id===alert.id);assert.equal(alert.decision,'UNCONFIRMED');assert.equal(alert.task,true);clock.configure({offsetMs:0,speed:1});cleanForDay();
});

test('quiet-hour escalation skips caregivers, audits skips and reaches EXHAUSTED',()=>{
  const target=Date.UTC(2026,9,20,6,0,0);clock.configure({offsetMs:target-Date.now(),speed:1});cleanForDay();
  const alert=ensureToday({force:true});store.mutate(state=>{const item=state.alerts.find(a=>a.id===alert.id);item.task=true;item.decision='UNCONFIRMED';item.ackDeadlineAt=clock.now().toISOString();});
  sweep();const exhausted=store.get().alerts.find(item=>item.id===alert.id);assert.equal(exhausted.state,'EXHAUSTED');assert.equal(exhausted.reason,'Nobody acknowledged. Suggested next step: contact a neighbor or local support service. CareLoop does not contact emergency services.');assert.ok(store.get().audit.filter(entry=>entry.action==='quiet_hour_skip'&&entry.alertId===alert.id).length>=1);
  clock.configure({offsetMs:0,speed:1});
});

test('recipient help creates urgent task, phone confirmation source is distinct, and okay closes a daily alert',async()=>{
  clock.configure({offsetMs:0,speed:1});cleanForDay();
  const help=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'help'}});assert.equal(help.response.status,200);assert.equal(help.result.alert.priority,'urgent');assert.equal(help.result.alert.state,'ASSIGNED');
  const phone=await request(`/api/alerts/${help.result.alert.id}/confirm-by-phone`,{method:'POST',body:{note:'Spoke by phone'}});assert.equal(phone.response.status,200);assert.equal(phone.result.alert.confirmationSource,'caregiver_phone');
  cleanForDay();const okay=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'ok'}});assert.equal(okay.result.alert.state,'RESOLVED');assert.equal(okay.result.alert.confirmationSource,'recipient');
  const repeated=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'help'}});assert.equal(repeated.response.status,200);assert.equal(repeated.result.message,'Thanks for checking in. Your family has received your response.');assert.equal(JSON.stringify(repeated.result).includes('ALERT_TERMINAL'),false);
});

test('demo reset is unavailable when disabled and allows the same-day scenario to run again',async()=>{
  cleanForDay();const okay=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'ok'}});assert.equal(okay.result.alert.state,'RESOLVED');
  const original=process.env.DEMO_MODE;process.env.DEMO_MODE='false';try{const disabled=await request('/api/demo/reset',{user:'margaret',method:'POST',body:{}});assert.equal(disabled.response.status,404);}finally{if(original===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=original;}
  const reset=await request('/api/demo/reset',{user:'margaret',method:'POST',body:{}});assert.equal(reset.response.status,200);assert.equal(reset.result.ok,true);const help=await request('/api/recipient/confirm',{user:'margaret',method:'POST',body:{status:'help'}});assert.equal(help.response.status,200);assert.equal(help.result.alert.priority,'urgent');assert.equal(help.result.alert.state,'ASSIGNED');
});

test('caregiver acknowledgement requires note; ack/escalation race produces one version transition',async()=>{
  clock.configure({offsetMs:Date.UTC(2026,9,20,16)-Date.now(),speed:1});cleanForDay();const alert=ensureToday({force:true});store.mutate(state=>{const item=state.alerts.find(a=>a.id===alert.id);item.task=true;item.decision='UNCONFIRMED';item.ackDeadlineAt=clock.now().toISOString();});
  const missing=await request(`/api/alerts/${alert.id}/ack`,{method:'POST',body:{note:''}});assert.equal(missing.response.status,400);
  const action=request(`/api/alerts/${alert.id}/ack`,{method:'POST',body:{note:'I will check in'}});sweep();const result=await action;const current=store.get().alerts.find(item=>item.id===alert.id);assert.equal(current.version,1);assert.ok(['ACKNOWLEDGED','ESCALATED'].includes(current.state));
  clock.configure({offsetMs:0,speed:1});
});

test('demo clock and caregiver data pages are functional via same-origin sessions',async()=>{
  const page=await fetch(base+'/caregiver');const cookie=page.headers.get('set-cookie').split(';')[0];
  const update=await fetch(base+'/api/clock',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({speed:1.25})});assert.equal(update.status,200);assert.equal((await update.json()).speed,1.25);
  const sources=await fetch(base+'/sources');const sourceCookie=sources.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(base+'/api/sources',{headers:{Cookie:sourceCookie}})).status,200);
  clock.configure({offsetMs:0,speed:1});
});

test('DEMO_MODE gate and tombstone-only household deletion',async()=>{
  // The deployed gate is a server constant derived from the environment; the default demo is enabled.
  assert.equal(require('../src/server').demo,true);
  cleanForDay();const deletion=await request('/api/household',{user:'margaret',method:'DELETE'});assert.equal(deletion.response.status,200);assert.equal(deletion.result.deleted,true);assert.deepEqual(Object.keys(store.get()),['tombstone']);
});
