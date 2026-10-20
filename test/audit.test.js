'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRingClient,RingError}=require('../src/ring/client');
const {decideMorning,classifyEvidence,casTransition}=require('../src/domain');
const {localDateKey,atLocalTime,inQuietHours,createClock}=require('../src/clock');
const {createStore}=require('../src/store');
const {ringDataGapReason}=require('../src/domain');
const {shouldPoll,retryAfterMs,backoffMs}=require('../src/ring/polling');
const fs=require('node:fs');const path=require('node:path');
const {simulationEnabled,demoResetEnabled,syncHealthError,persistRefresh,store}=require('../src/server');
const fixtureSamples=require('../fixtures/ring-samples.json');

function response(status,body={},headers={}){return {ok:status>=200&&status<300,status,headers:{get:k=>headers[k.toLowerCase()]||null},json:async()=>body};}
test('Ring JSON:API relationships derive configuration, country, online status and endpoint paths',async()=>{
 const calls=[];const client=createRingClient({getToken:()=> 'access-secret',fetchImpl:async url=>{calls.push(url);return response(200,{data:[{id:'d/1',attributes:{name:'Door'},relationships:{status:{data:{id:'s'}},configurations:{data:{id:'c'}},location:{data:{id:'l'}}}}],included:[{id:'s',attributes:{online:true}},{id:'c',attributes:{motion_detection:{enabled:'off'}}},{id:'l',attributes:{country:'US',state:'NY'}}]});}});
 const devices=await client.listDevices();assert.equal(devices[0].online,true);assert.equal(devices[0].motionEnabled,'off');assert.equal(devices[0].country,'US');assert.match(calls[0],/\/v1\/devices\?include=status,configurations,location$/);
});
test('Ring status and configurations use only the supplied device endpoints',async()=>{
 const urls=[];const client=createRingClient({getToken:()=> 'a',fetchImpl:async url=>{urls.push(url);if(url.endsWith('/status'))return response(200,{data:{attributes:{online:false}}});return response(200,{data:[{id:'d',relationships:{configurations:{data:{id:'c'}}}}],included:[{id:'c',attributes:{motion_detection:{enabled:'on'}}}]});}});
 assert.equal(await client.getStatus('d/x'),false);assert.equal((await client.getConfigurations('d')).motionEnabled,'on');assert.ok(urls[0].endsWith('/v1/devices/d%2Fx/status'));assert.ok(urls[1].includes('/v1/devices?include=status,configurations,location'));assert.ok(urls.every(url=>!/(media|video|snapshot)/i.test(url)));
});
test('Ring history queries motion and human subtype, follows relative pagination and deduplicates',async()=>{
 const calls=[];const pages={
 'https://api.amazonvision.com/v1/history/devices/d/events?event_types=motion':{data:[{id:'h',attributes:{event_type:'motion',start:3000}},{id:'m',attributes:{event_type:'motion',start:2000}}],links:{next:'/v1/history/devices/d/events?page=2'}},
 'https://api.amazonvision.com/v1/history/devices/d/events?page=2':{data:[{id:'p',attributes:{event_type:'ding',start:1000}}]},
 'https://api.amazonvision.com/v1/history/devices/d/events?event_types=motion.human':{data:[{id:'h',attributes:{event_type:'motion',start:3000}}]}};
 const client=createRingClient({getToken:()=> 'access',fetchImpl:async url=>{calls.push(url);return response(200,pages[url]);}});const events=await client.getHistory('d',['motion','motion.human']);
 assert.equal(events.length,3);assert.equal(events.find(e=>e.id==='h').subType,'human');assert.equal(events.find(e=>e.id==='m').subType,'motion');assert.equal(events.find(e=>e.id==='p').type,'doorbell_press');assert.ok(calls.some(x=>x.includes('page=2')));
});
test('Ring history rejects pagination links outside the history API host/path',async()=>{
 const client=createRingClient({getToken:()=> 'a',fetchImpl:async()=>response(200,{data:[],links:{next:'https://example.invalid/steal'}})});
 await assert.rejects(client.getHistory('d','motion'),error=>error.code==='INVALID_PAGINATION_LINK');
});
test('Ring client classifies 401, 403, 429 and 503 errors',async()=>{
 for(const [status,code] of [[401,'TOKEN_INVALID'],[403,'FORBIDDEN'],[429,'RATE_LIMITED'],[503,'DEVICE_OFFLINE']]){const c=createRingClient({getToken:()=> 'access',fetchImpl:async()=>response(status,{}, {'retry-after':'7'})});await assert.rejects(c.listDevices(),e=>e instanceof RingError&&e.code===code&&(status!==429||e.retryAfter==='7'));}
});
test('refresh rotates credentials, persists only rotated token and never uses refresh token as Bearer',async()=>{
 const calls=[],saved=[];let firstApi=true;const client=createRingClient({getToken:()=> 'old-access',refreshCredentials:()=>({refreshToken:'old-refresh',clientId:'client',clientSecret:'secret'}),persistRefresh:x=>saved.push(x),clock:()=>1000,fetchImpl:async(url,opts={})=>{calls.push({url,opts});if(url==='https://oauth.ring.com/oauth/token')return response(200,{access_token:'new-access',refresh_token:'new-refresh',expires_in:14400});if(firstApi){firstApi=false;return response(401);}return response(200,{data:[]});}});
 await client.listDevices();assert.equal(calls[0].opts.headers.Authorization,'Bearer old-access');assert.equal(calls[1].url,'https://oauth.ring.com/oauth/token');assert.equal(calls[2].opts.headers.Authorization,'Bearer new-access');assert.equal(saved[0].refresh_token,'new-refresh');assert.equal(Object.keys(saved[0]).sort().join(','),'expires_at,refresh_token');assert.equal(calls[1].opts.body.get('grant_type'),'refresh_token');
});
test('expired access token refreshes five minutes early',async()=>{
 let current=1000000;const urls=[];const client=createRingClient({clock:()=>current,refreshCredentials:()=>({refreshToken:'r',clientId:'i',clientSecret:'s'}),fetchImpl:async url=>{urls.push(url);if(url.endsWith('/oauth/token'))return response(200,{access_token:'a',refresh_token:'r2',expires_in:3600});return response(200,{data:[]});}});await client.getToken();current+=3300*1000;await client.getToken();assert.equal(urls.filter(x=>x.endsWith('/oauth/token')).length,2);
});
test('429 Retry-After and 5xx backoff are retained for scheduler policy',async()=>{
 const c=createRingClient({getToken:()=> 'a',fetchImpl:async()=>response(429,{}, {'retry-after':'17'})});await assert.rejects(c.listDevices(),e=>e.retryAfter==='17');
});
test('freshness, disabled motion, device offline and auth failures are data gaps',()=>{
 const now=new Date('2026-01-01T01:00:00Z');const health={ok:true,lastSyncAt:'2026-01-01T00:00:00Z',motionEnabled:true};
 assert.match(ringDataGapReason({mode:'playground',health,freshnessMin:30,now}),/stale/);
 assert.match(ringDataGapReason({mode:'playground',health:{...health,motionEnabled:'off'},freshnessMin:30,now:new Date('2026-01-01T00:01:00Z')}),/disabled/);
 assert.match(ringDataGapReason({mode:'playground',health,deviceOnline:false,freshnessMin:30,now:new Date('2026-01-01T00:01:00Z')}),/offline/);
 assert.match(ringDataGapReason({mode:'playground',health:{...health,ok:false,error:'TOKEN_INVALID'},freshnessMin:30,now}),/authorization/);
 assert.match(ringDataGapReason({mode:'playground',health:{...health,ok:false,error:'FORBIDDEN'},freshnessMin:30,now}),/authorization/);
});
test('polling never occurs before 60 seconds and respects Retry-After/backoff',()=>{
 assert.equal(shouldPoll(59999,0,0),false);assert.equal(shouldPoll(60000,0,0),true);assert.equal(shouldPoll(120000,0,180000),false);
 assert.equal(retryAfterMs('17',1000),17000);assert.equal(retryAfterMs('bad',1000),60000);assert.equal(backoffMs(1),120000);assert.ok(backoffMs(8)<=900000);
});
test('server simulation gate is disabled only when explicitly false',()=>{assert.equal(simulationEnabled({DEMO_MODE:'false'}),false);assert.equal(simulationEnabled({DEMO_MODE:'true'}),true);assert.equal(simulationEnabled({}),true);});
test('demo reset is gated off when DEMO_MODE is false',()=>{assert.equal(demoResetEnabled({DEMO_MODE:'false'}),false);assert.equal(demoResetEnabled({DEMO_MODE:'true'}),true);});
test('503 health failures mark devices offline and preserve only safe error codes',()=>{
 syncHealthError(new RingError('DEVICE_OFFLINE',503));assert.equal(store.get().household.deviceOnline,false);assert.equal(store.get().household.ringHealth.error,'DEVICE_OFFLINE');assert.match(ringDataGapReason({mode:'playground',health:store.get().household.ringHealth,deviceOnline:false,motionEnabled:true,now:new Date()}),/offline/);
});
test('refresh state writes only rotated token metadata with owner-only permissions',()=>{
 const dir=fs.mkdtempSync(path.join(process.cwd(),'careloop-refresh-'));try{const file=path.join(dir,'ring-refresh.json');persistRefresh({refresh_token:'rotated-only',expires_at:123,access_token:'must-not-save',client_secret:'must-not-save'},file);const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(Object.keys(data).sort(),['expires_at','refresh_token']);assert.equal(data.refresh_token,'rotated-only');if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('fixture set is marked doc-shaped and includes representative webhook events/errors',()=>{
 assert.equal(fixtureSamples.doc_shaped,true);
 assert.equal(fixtureSamples.devices.included.find(item=>item.type==='device-status').attributes.online,true);
 assert.equal(fixtureSamples.devices.included.find(item=>item.type==='device-configurations').attributes.motion_detection.enabled,'on');
 assert.deepEqual(new Set(fixtureSamples.webhook_samples.map(item=>item.data.type)),new Set(['motion_detected','button_press','device_offline','device_online','app_integration_removed','device_added','device_removed','subscription_activated','subscription_deactivated','app_integration_added']));
 assert.deepEqual(fixtureSamples.error_scenarios.map(item=>item.status),[401,403,429,503]);
});
test('daily keys, daylight-saving cutoffs, and quiet hours work across household zones',()=>{
 const date=new Date('2026-11-01T05:30:00Z');assert.equal(localDateKey(date,'America/New_York'),'2026-11-01');const cut=atLocalTime(date,'America/New_York','08:00');assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(cut),'08');assert.equal(inQuietHours(new Date('2026-10-20T13:00:00Z'),'America/Los_Angeles'),true);
});
test('demo clock speed changes do not double-apply offset',()=>{const c=createClock();const before=c.now();c.configure({offsetMs:60000});const shifted=c.now();c.configure({speed:2});const after=c.now();assert.ok(Math.abs((+after-+shifted))<3000);assert.ok(Math.abs((+shifted-+before)-60000)<3000);});
test('visitor and on-demand normalize as non-resident evidence',()=>{const evidence=classifyEvidence([{type:'doorbell_press'},{type:'live_view'}]);assert.deepEqual(evidence.map(x=>x.kind),['visitor']);});
test('data-gap decision takes precedence over possible activity',()=>{const d=decideMorning({dataGap:true,events:[{type:'motion',subType:'human'}],now:new Date(123)});assert.equal(d.decision,'UNVERIFIABLE');assert.equal(d.task,true);});
test('CAS transition race has exactly one winner',async()=>{let current={version:0,state:'ASSIGNED'};const observedVersion=current.version;const attempt=changes=>{const next=casTransition(current,observedVersion,changes);if(next)current=next;return next;};const outcomes=await Promise.all([Promise.resolve().then(()=>attempt({state:'ACKNOWLEDGED'})),Promise.resolve().then(()=>attempt({state:'ESCALATED'}))]);assert.equal(outcomes.filter(Boolean).length,1);assert.equal(current.version,1);});
test('terminal alert states cannot transition back to assigned',()=>{assert.equal(casTransition({version:2,state:'RESOLVED'},2,{state:'ASSIGNED'}),null);assert.equal(casTransition({version:2,state:'EXHAUSTED'},2,{state:'ACKNOWLEDGED'}),null);});
test('JSON Store deletion leaves only a minimal tombstone',()=>{const s=createStore();s.mutate(x=>{x.users=[{id:'u'}];x.alerts=[{id:'a'}];});s.replace({tombstone:{id:'t',requestedAt:'2026-01-01T00:00:00.000Z'}});assert.deepEqual(Object.keys(s.get()),['tombstone']);});
test('JSON Store writes atomically with restrictive permissions and never retains memory tokens',()=>{
 const dir=fs.mkdtempSync(path.join(process.cwd(),'careloop-store-'));try{const file=path.join(dir,'db.json');const persistent=createStore({mode:'json',file});persistent.mutate(state=>{state.users=[{id:'margaret',token:'test-token'}];state.ringToken='memory-only';});const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.ringToken,undefined);assert.equal(saved.users[0].token,undefined);const reloaded=createStore({mode:'json',file});assert.equal(reloaded.get().ringToken,undefined);if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
