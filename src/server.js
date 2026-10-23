'use strict';
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const express=require('express');
const {createStore}=require('./store');
const {createClock,localDateKey,localMinutes,inQuietHours,atLocalTime}=require('./clock');
const {decideMorning,casTransition,newAlert,ringDataGapReason,EXHAUSTED_TEXT}=require('./domain');
const {createRingClient,RingError}=require('./ring/client');
const {shouldPoll,retryAfterMs,backoffMs}=require('./ring/polling');

const app=express();
const store=createStore();
const clock=createClock();
const mode=['fixtures','playground','simulator'].includes(process.env.RING_MODE)?process.env.RING_MODE:'fixtures';
function simulationEnabled(environment={}){return environment.DEMO_MODE!=='false';}
function demoResetEnabled(environment={}){return simulationEnabled(environment);}
const demo=simulationEnabled(process.env);
const webhookSecret=process.env.RING_WEBHOOK_SECRET||'careloop-local-demo-webhook-secret';
function ringCredentialsAvailable(){return Boolean(pastedAccessToken||process.env.RING_ACCESS_TOKEN||(process.env.RING_REFRESH_TOKEN&&process.env.RING_CLIENT_ID&&process.env.RING_CLIENT_SECRET));}
const seedUsers=[
  {id:'margaret',name:'Margaret',role:'recipient',tz:'America/New_York',quietHours:{start:'22:00',end:'07:00'},testToken:'careloop-demo-margaret-token'},
  {id:'priya',name:'Priya',role:'primary',tz:'America/Los_Angeles',quietHours:{start:'22:00',end:'07:00'},testToken:'careloop-demo-priya-token'},
  {id:'arjun',name:'Arjun',role:'backup',tz:'America/Chicago',quietHours:{start:'22:00',end:'07:00'},testToken:'careloop-demo-arjun-token'}
];
const fixture=require('../fixtures/ring-samples.json');
const uiSessions=new Map();
let pastedAccessToken=null;
let lastPoll=-Infinity,pollNotBefore=-Infinity,serverErrorCount=0;

function seedState() {
  const state=store.get();
  if(state.tombstone)return;
  if(state.household){clock.configure(state.clock||{});return;}
  const now=clock.now().toISOString();
  state.users=seedUsers.map(({testToken,...user})=>user);
  state.household={
    id:'household',tz:process.env.HOUSEHOLD_TZ||'America/New_York',promptAt:'08:00',reminderAt:'09:30',cutoff:'10:00',cutoffAt:'10:00',
    ackWindowMin:5,freshnessMin:30,promoteAfterMin:60,ringConsentAt:now,
    ringHealth:{ok:mode!=='playground',lastSyncAt:mode==='playground'?null:now,lastSyncMode:mode==='playground'?null:mode,error:null,motionEnabled:true,country:'US'},
    sharingPaused:false,consents:{priya:{approved:true,role:'primary',approvedAt:now},arjun:{approved:true,role:'backup',approvedAt:now}},
    retentionDays:30,deviceOnline:true,motionEnabled:true
  };
  state.events=mode==='fixtures'?fixture.events.map(event=>({...event})):[];
  pruneRetention(state);
  store.save();
  clock.configure(state.clock||{});
}
seedState();

function loadRefreshState() {
  try{return JSON.parse(fs.readFileSync(path.resolve('data/ring-refresh.json'),'utf8'));}
  catch{return null;}
}
function persistRefresh(value,file=path.resolve('data/ring-refresh.json')) {
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify({refresh_token:value.refresh_token,expires_at:value.expires_at}),{mode:0o600});
  fs.renameSync(tmp,file);
  try{fs.chmodSync(file,0o600);}catch{}
}
const ringClient=createRingClient({
  getToken:()=>pastedAccessToken,
  refreshCredentials:()=>{
    const persisted=loadRefreshState();
    return {refreshToken:process.env.RING_REFRESH_TOKEN||persisted?.refresh_token,clientId:process.env.RING_CLIENT_ID,clientSecret:process.env.RING_CLIENT_SECRET};
  },
  persistRefresh:persistRefresh,
  clock:()=>+clock.now()
});

function pruneRetention(state,now=clock.now()) {
  const cutoff=+now-(state.household?.retentionDays||30)*86400000;
  state.audit=state.audit.filter(entry=>+new Date(entry.at)>=cutoff);
  state.accessLog=state.accessLog.filter(entry=>+new Date(entry.at)>=cutoff);
  state.events=state.events.filter(event=>!event.ts||+new Date(event.ts)>=cutoff);
  state.alerts=state.alerts.filter(alert=>+new Date(alert.createdAt)>=cutoff);
  state.notifications=(state.notifications||[]).filter(item=>+new Date(item.at)>=cutoff);
  state.confirmations=Object.fromEntries(Object.entries(state.confirmations||{}).filter(([,item])=>+new Date(item.at)>=cutoff));
  state.webhookRequests=(state.webhookRequests||[]).filter(item=>typeof item==='string'||+new Date(item.at)>=cutoff);
}
function audit(action,user=null,detail={}) {
  store.mutate(state=>{
    state.audit.push({id:crypto.randomUUID(),action,actorId:user?.id||null,role:user?.role||'system',at:clock.now().toISOString(),...detail});
    pruneRetention(state);
  });
}
function auth(req,res,next) {
  const header=req.get('authorization')||'';
  let user=null;
  if(header.startsWith('Bearer ')) {
    const seeded=seedUsers.find(item=>item.testToken===header.slice(7));
    if(seeded)user=store.get().users.find(item=>item.id===seeded.id)||null;
  }
  if(!user) {
    const cookie=(req.get('cookie')||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('careloop_session='));
    const sessionId=cookie?.slice('careloop_session='.length);
    const userId=sessionId&&uiSessions.get(sessionId);
    if(userId)user=store.get().users.find(item=>item.id===userId)||null;
  }
  if(!user)return res.status(401).json({error:'UNAUTHORIZED'});
  req.user=user;next();
}
function roles(...allowed) {
  return (req,res,next)=>{
    if(!allowed.includes(req.user.role))return res.status(403).json({error:'FORBIDDEN'});
    if(['primary','backup'].includes(req.user.role)) {
      const household=store.get().household;
      if(household.sharingPaused||!household.consents?.[req.user.id]?.approved) {
        audit('caregiver_access_denied',req.user,{reason:household.sharingPaused?'sharing_paused':'consent_missing'});
        return res.status(403).json({error:'CONSENT_REQUIRED'});
      }
    }
    next();
  };
}
function accessRead(req,resource) {
  store.mutate(state=>{state.accessLog.push({id:crypto.randomUUID(),caregiverId:req.user.id,role:req.user.role,at:clock.now().toISOString(),resource});pruneRetention(state);});
}
function currentDay(){return localDateKey(clock.now(),store.get().household.tz);}
function dayKey(day=currentDay()){return `${store.get().household.id}#${day}`;}
function alertForToday(state=store.get()){return state.alerts.find(alert=>alert.dailyKey===dayKey())||null;}
function selectConsentedOwner(state) {
  return state.users.find(user=>user.role==='primary'&&state.household.consents?.[user.id]?.approved)
    ||state.users.find(user=>user.role==='backup'&&state.household.consents?.[user.id]?.approved)
    ||null;
}
function dataGapReason(state=store.get(),now=clock.now()) {
  const household=state.household;
  return ringDataGapReason({mode,health:household.ringHealth,deviceOnline:household.deviceOnline,motionEnabled:household.motionEnabled,freshnessMin:household.freshnessMin,now});
}
function isAfterPrompt(now=clock.now()) {
  const household=store.get().household;
  return +now>=+atLocalTime(now,household.tz,household.promptAt);
}
function isAfterCutoff(now=clock.now()) {
  const household=store.get().household;
  return +now>=+atLocalTime(now,household.tz,household.cutoff);
}
function decisionFor(state,now) {
  const reason=dataGapReason(state,now);
  return decideMorning({dataGap:Boolean(reason),dataGapReason:reason,events:state.events,now,ackWindowMin:state.household.ackWindowMin,promoteAfterMin:state.household.promoteAfterMin});
}
function updateAlert(alert,changes) {
  return store.mutate(state=>{
    const index=state.alerts.findIndex(item=>item.id===alert.id);
    if(index<0)return null;
    const next=casTransition(state.alerts[index],alert.version,{...changes,updatedAt:clock.now().toISOString()});
    if(next)state.alerts[index]=next;
    return next;
  });
}
function applyDecision(alert,decision) {
  return updateAlert(alert,{decision:decision.decision,state:decision.state,task:decision.task,
    ackDeadlineAt:decision.ackDeadlineAt||null,promoteAt:decision.promoteAt||null,priority:decision.priority||'normal',
    secondPrompt:Boolean(decision.secondPrompt),reason:decision.reason||decision.evidence?.map(item=>item.text).join(' ')||'',evidence:decision.evidence||[]});
}
function mergeDataGap(alert,reason) {
  if(!alert||['RESOLVED','EXHAUSTED'].includes(alert.state)||alert.decision==='UNVERIFIABLE')return alert;
  const state=store.get(),ownerAllowed=state.household.consents?.[alert.ownerId]?.approved;
  const replacement=ownerAllowed?state.users.find(user=>user.id===alert.ownerId):selectConsentedOwner(state);
  const noOwner=!replacement;
  const nextState=noOwner?'EXHAUSTED':!ownerAllowed&&alert.task?'ESCALATED':alert.state;
  const deadline=nextState==='ACKNOWLEDGED'?null:new Date(+clock.now()+state.household.ackWindowMin*60000).toISOString();
  const updated=updateAlert(alert,{decision:'UNVERIFIABLE',state:nextState,task:true,priority:'urgent',ackDeadlineAt:noOwner?null:deadline,promoteAt:null,ownerId:replacement?.id||null,ownerRole:replacement?.role||null,reason:noOwner?EXHAUSTED_TEXT:reason,evidence:alert.evidence||[]})||alert;
  if(updated.ownerId&&(!alert.task||alert.ownerId!==updated.ownerId))notify(updated.ownerId,'alert','CareLoop has an UNVERIFIABLE task.',updated.id);
  if(updated.state==='EXHAUSTED'&&alert.state!=='EXHAUSTED')audit('alert_exhausted',null,{alertId:updated.id,reason:'no_consented_caregiver'});
  return updated;
}
function notify(userId,kind,message,alertId=null) {
  const target=store.get().users.find(user=>user.id===userId);
  if(['primary','backup'].includes(target?.role)) {
    const state=store.get(),consented=state.household.consents?.[userId]?.approved;
    const quiet=inQuietHours(clock.now(),target.tz,target.quietHours?.start,target.quietHours?.end);
    if(state.household.sharingPaused||!consented||quiet) {
      const reason=state.household.sharingPaused?'sharing_paused':!consented?'consent_missing':'quiet_hours';
      if(quiet)audit('quiet_hour_skip',null,{caregiverId:userId,alertId,reason:'notification'});
      else audit('caregiver_notification_skipped',null,{caregiverId:userId,alertId,reason});
      return null;
    }
  }
  store.mutate(state=>state.notifications.push({id:crypto.randomUUID(),userId,kind,message,alertId,at:clock.now().toISOString()}));
  if(process.env.NOTIFY_URL&&['alert','urgent_help','exhausted'].includes(kind))fetch(process.env.NOTIFY_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:message}).catch(()=>{});
}
function createTodayAlert({force=false}={}) {
  const state=store.get();
  if(state.tombstone||!state.household)return null;
  let existing=alertForToday(state);
  const gap=dataGapReason(state);
  if(existing) {
    if(gap)existing=mergeDataGap(existing,gap);
    return existing;
  }
  if(!force&&!gap&&!isAfterPrompt())return null;
  const now=clock.now();
  const decision=gap?decideMorning({dataGap:true,dataGapReason:gap,now,ackWindowMin:state.household.ackWindowMin}):isAfterCutoff(now)?decisionFor(state,now):{
    decision:'MORNING_CHECK',state:'ASSIGNED',task:false,ackDeadlineAt:atLocalTime(now,state.household.tz,state.household.cutoff).toISOString(),
    reason:'Morning check-in is open; awaiting Margaret’s confirmation.',priority:'low'
  };
  return store.mutate(current=>{
    const duplicate=current.alerts.find(item=>item.dailyKey===`${current.household.id}#${currentDay()}`);
    if(duplicate)return duplicate;
    const owner=selectConsentedOwner(current);
    const created=newAlert(current.household,currentDay(),owner,decision,now);
    created.task=Boolean(decision.task);
    created.source=decision.evidence?.[0]?.event?.source|| (mode==='fixtures'?'fixture':'ring_api');
    if(decision.task&&!owner){created.state='EXHAUSTED';created.reason=EXHAUSTED_TEXT;created.ownerId=null;created.ownerRole=null;}
    current.alerts.push(created);
    if(decision.task&&owner)notify(owner.id,'alert',`CareLoop ${decision.decision.toLowerCase()} task`,created.id);
    if(decision.secondPrompt)for(const recipient of current.users.filter(user=>user.role==='recipient'))notify(recipient.id,'second_prompt','Please check in with your family.',created.id);
    if(created.state==='EXHAUSTED')audit('alert_exhausted',null,{alertId:created.id,reason:'no_consented_caregiver'});
    return created;
  });
}
function ensureToday(options){return createTodayAlert(options);}

function syncHealthError(error) {
  const code=error.code||'RING_UNAVAILABLE';
  store.mutate(state=>{
    state.household.ringHealth={...state.household.ringHealth,ok:false,error:code};
    if(error.status===503){state.household.deviceOnline=false;state.household.ringHealth.error=code==='RING_UNAVAILABLE'?'DEVICE_OFFLINE':code;}
  });
  audit('ring_sync_error',null,{code});
  const alert=alertForToday();if(alert)mergeDataGap(alert,dataGapReason()||'Ring data is unavailable.');
}
async function syncRing() {
  if(mode==='fixtures'||mode==='simulator')return false;
  const now=+clock.now();
  if(!shouldPoll(now,lastPoll,pollNotBefore))return false;
  lastPoll=now;
  try {
    const devices=await ringClient.listDevices();
    if(!devices.length)throw new RingError('NO_DEVICES',503);
    const histories=[];
    for(const device of devices) {
      const online=device.online??await ringClient.getStatus(device.id);
      const configuration=device.motionEnabled===null?await ringClient.getConfigurations(device.id):device;
      if(online===false)throw new RingError('DEVICE_OFFLINE',503);
      if(configuration.motionEnabled==='off') {
        store.mutate(state=>{state.household.motionEnabled=false;state.household.ringHealth.motionEnabled=false;});
      }
      histories.push(...await ringClient.getHistory(device.id,['motion','motion.human']));
    }
    const consentAt=+new Date(store.get().household.ringConsentAt||0);
    const afterConsent=histories.filter(event=>event.ts&&+new Date(event.ts)>=consentAt);
    store.mutate(state=>{
      state.events=[...afterConsent,...state.events.filter(event=>event.source==='webhook'||event.source==='simulated'||(mode==='fixtures'&&event.source==='fixture'))].sort((a,b)=>Date.parse(b.ts||0)-Date.parse(a.ts||0));
      state.household.deviceOnline=true;
      state.household.motionEnabled=devices.every(device=>device.motionEnabled!=='off');
      state.household.ringHealth={ok:true,lastSyncAt:clock.now().toISOString(),lastSyncMode:'playground',error:null,motionEnabled:state.household.motionEnabled,country:devices[0]?.country||null,state:devices[0]?.state||null};
    });
    pollNotBefore=-Infinity;serverErrorCount=0;
    ensureToday();return true;
  } catch(error) {
    const ringError=error instanceof RingError?error:new RingError('RING_UNAVAILABLE',502);
    syncHealthError(ringError);
    if(ringError.status===429)pollNotBefore=+clock.now()+Math.max(60000,retryAfterMs(ringError.retryAfter,+clock.now()));
    else if(ringError.status>=500){serverErrorCount++;pollNotBefore=+clock.now()+backoffMs(serverErrorCount);}
    else pollNotBefore=+clock.now()+60000;
    ensureToday();return false;
  }
}

function safeHousehold(state=store.get()) {
  if(!state.household)return null;
  return {...state.household,consents:Object.fromEntries(Object.entries(state.household.consents||{}).map(([id,c])=>[id,{approved:Boolean(c.approved),role:c.role}]))};
}
function signed(raw,signature) {
  if(!Buffer.isBuffer(raw)||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(signature))return false;
  const expected=crypto.createHmac('sha256',webhookSecret).update(raw).digest();
  const supplied=Buffer.from(signature.slice(7),'hex');
  return expected.length===supplied.length&&crypto.timingSafeEqual(expected,supplied);
}
function verifySignedPayload(raw,signature) {
  if(!signed(raw,signature))return {error:'BAD_SIGNATURE'};
  try{return {payload:JSON.parse(raw.toString('utf8'))};}catch{return {error:'INVALID_JSON'};}
}
function processWebhook(payload,source) {
  const meta=payload?.meta||{},data=payload?.data||{},attributes=data.attributes||{};
  if(meta.request_id&&store.get().webhookRequests.some(item=>(typeof item==='string'?item:item.id)===meta.request_id))return {duplicate:true};
  const type=data.type||'unknown';
  const timestamp=Number(attributes.timestamp);
  const ts=Number.isFinite(timestamp)?new Date(timestamp).toISOString():clock.now().toISOString();
  const consentAt=+new Date(store.get().household.ringConsentAt||0);
  const afterConsent=+new Date(ts)>=consentAt;
  const deviceId=attributes.source||null;
  const controlTypes=new Set(['token_expired','motion_detection_disabled']);
  const motionSubtypes=new Set(['vehicle','animal','other_motion','package_delivery']);
  const event={id:String(data.id||meta.request_id||crypto.randomUUID()),deviceId,
    type:['motion_detected','motion.human','motion'].includes(type)||motionSubtypes.has(type)?'motion':type==='button_press'?'doorbell_press':type==='device_offline'?'device_offline':type==='device_online'?'device_online':type==='delivery'?'delivery':['live_view','on_demand'].includes(type)?'live_view':'unknown',
    subType:attributes.sub_type||(motionSubtypes.has(type)?type:type==='motion.human'?'human':['motion','motion_detected'].includes(type)?'motion':null),ts,source};
  store.mutate(state=>{
    if(meta.request_id)state.webhookRequests.push({id:meta.request_id,at:clock.now().toISOString()});
    if(afterConsent&&!state.events.some(item=>item.id===event.id))state.events.push(event);
    state.events.sort((a,b)=>Date.parse(b.ts||0)-Date.parse(a.ts||0));
    if(afterConsent&&type==='device_offline'){state.household.deviceOnline=false;state.household.ringHealth={...state.household.ringHealth,error:'DEVICE_OFFLINE'};}
    if(afterConsent&&type==='device_online'){
      state.household.deviceOnline=true;
      if(state.household.ringHealth.error==='DEVICE_OFFLINE'){
        const last=state.household.ringHealth.lastSyncAt;
        const fresh=mode==='fixtures'||(last&&+clock.now()-+new Date(last)<=state.household.freshnessMin*60000);
        state.household.ringHealth={...state.household.ringHealth,error:null,ok:Boolean(fresh)};
      }
    }
    if(afterConsent&&type==='app_integration_removed')state.household.ringHealth={...state.household.ringHealth,ok:false,error:'APP_INTEGRATION_REMOVED'};
    if(afterConsent&&type==='token_expired')state.household.ringHealth={...state.household.ringHealth,ok:false,error:'TOKEN_INVALID'};
    if(afterConsent&&type==='motion_detection_disabled'){state.household.motionEnabled=false;state.household.ringHealth={...state.household.ringHealth,motionEnabled:false,error:'MOTION_DISABLED'};}
  });
  audit('webhook_received',null,{eventId:event.id,source,type});
  const alert=alertForToday(),gap=dataGapReason();if(alert&&gap)mergeDataGap(alert,gap);
  ensureToday();
  return {duplicate:false,event,known:!['unknown','device_added','device_removed','app_integration_added','subscription_activated','subscription_deactivated'].includes(type)};
}

function sessionForPage(req,res,page) {
  if(!demo)return;
  const roleByPage={caregiver:'priya',recipient:'margaret',sources:'priya'};
  const userId=roleByPage[page];
  const sessionId=crypto.randomUUID();
  uiSessions.set(sessionId,userId);
  res.cookie('careloop_session',sessionId,{httpOnly:true,sameSite:'strict',secure:Boolean(req.secure),path:'/',maxAge:8*60*60*1000});
  res.set('Cache-Control','no-store');
}
function authorizeDelete(req,res) {
  const tombstone={id:crypto.randomUUID(),timestamp:clock.now().toISOString()};
  store.replace({tombstone});
  uiSessions.clear();
  res.json({deleted:true,tombstone});
}

app.get('/health',(_req,res)=>res.json({ok:true}));
app.get('/api/clock',auth,roles('recipient','primary','backup'),(req,res)=>res.json(clock.state()));
app.post('/api/clock',auth,roles('recipient','primary','backup'),express.json(),(req,res)=>{
  const state=clock.configure(req.body||{});store.mutate(s=>s.clock={offsetMs:state.offsetMs,speed:state.speed});audit('clock_changed',req.user);res.json(state);
});
app.post('/api/ring/token',auth,roles('recipient'),express.json({limit:'8kb'}),(req,res)=>{
  const token=req.body?.accessToken;
  const normalized=typeof token==='string'?token.trim():'';
  const refreshCredentials=loadRefreshState();
  if(normalized.length<8||normalized===process.env.RING_REFRESH_TOKEN||normalized===refreshCredentials?.refresh_token)return res.status(400).json({error:'INVALID_ACCESS_TOKEN'});
  pastedAccessToken=normalized;ringClient.setAccessToken(pastedAccessToken);
  res.json({ok:true,stored:'memory_only'});
});
app.post('/ring/webhook',express.raw({type:'application/json',limit:'256kb'}),(req,res)=>{
  const verified=verifySignedPayload(req.body,req.get('x-signature'));
  if(verified.error==='BAD_SIGNATURE')return res.status(401).json({error:'BAD_SIGNATURE'});
  if(verified.error)return res.status(200).json({ok:true});
  const source=demo&&req.get('x-careloop-source')==='simulated'?'simulated':'webhook';
  res.status(200).json({ok:true});
  setImmediate(()=>{try{processWebhook(verified.payload,source);}catch{audit('webhook_processing_failed');}});
});
app.post('/api/simulate/event',express.raw({type:'application/json',limit:'256kb'}),(req,res)=>{
  if(!demo)return res.status(404).json({error:'SIMULATION_DISABLED'});
  const verified=verifySignedPayload(req.body,req.get('x-signature'));
  if(verified.error==='BAD_SIGNATURE')return res.status(401).json({error:'BAD_SIGNATURE'});
  if(verified.error)return res.status(400).json({error:'INVALID_JSON'});
  res.status(200).json({ok:true});
  setImmediate(()=>{try{processWebhook(verified.payload,'simulated');}catch{audit('simulation_processing_failed');}});
});
app.use(express.json({limit:'32kb'}));

app.post('/api/demo/scenario',auth,roles('recipient','primary','backup'),(req,res)=>{
  if(!demo)return res.status(404).json({error:'SIMULATION_DISABLED'});
  const scenarios={visitor:['button_press',null],motion:['motion_detected','human'],offline:['device_offline','motion'],recover:['device_online',null],token:['token_expired',null],disabled:['motion_detection_disabled',null]};
  const [type,subType]=scenarios[req.body?.kind]||[];if(!type)return res.status(400).json({error:'UNKNOWN_SCENARIO'});
  const payload={meta:{version:'1.1',time:+clock.now(),request_id:crypto.randomUUID(),account_id:'local-demo'},data:{id:crypto.randomUUID(),type,attributes:{source:'demo-device',timestamp:+clock.now(),sub_type:subType}}};
  const raw=Buffer.from(JSON.stringify(payload)),signature='sha256='+crypto.createHmac('sha256',webhookSecret).update(raw).digest('hex');
  const verified=verifySignedPayload(raw,signature);if(verified.error)return res.status(500).json({error:'SIMULATION_FAILED'});
  setImmediate(()=>{try{processWebhook(verified.payload,'simulated');}catch{audit('simulation_processing_failed');}});res.json({ok:true});
});
app.post('/api/demo/reset',auth,roles('recipient','primary','backup'),(req,res)=>{
  if(!demoResetEnabled(process.env))return res.status(404).json({error:'NOT_FOUND'});
  clock.configure({offsetMs:0,speed:1});store.reset();seedState();
  lastPoll=-Infinity;pollNotBefore=-Infinity;serverErrorCount=0;
  audit('demo_state_reset',req.user);res.json({ok:true,message:'Demo state reset. You can run the scenario again.'});
});
app.get('/api/household',auth,roles('recipient','primary','backup'),(req,res)=>res.json({household:safeHousehold(),mode,demoMode:demo,ringConfigured:mode==='playground'&&ringCredentialsAvailable()}));
app.get('/api/alerts',auth,roles('primary','backup'),(req,res)=>{ensureToday();accessRead(req,'alerts');res.json({alerts:store.get().alerts,exhaustedText:EXHAUSTED_TEXT});});
app.get('/api/timeline',auth,roles('primary','backup'),(req,res)=>{
  accessRead(req,'timeline');
  res.json({events:store.get().events.map(event=>({...event})),audit:store.get().audit.map(({actorId,role,at,action,eventId,source,type,alertId,state})=>({actorId,role,at,action,eventId,source,type,alertId,state}))});
});
app.get('/api/sources',auth,roles('primary','backup'),(req,res)=>{
  accessRead(req,'sources');const counts={};for(const event of store.get().events)counts[event.source]=(counts[event.source]||0)+1;
  res.json({counts,events:store.get().events});
});
app.get('/api/notifications',auth,roles('primary','backup'),(req,res)=>res.json({notifications:store.get().notifications.filter(item=>item.userId===req.user.id)}));
app.get('/api/recipient/status',auth,roles('recipient'),(req,res)=>res.json({alert:ensureToday(),notifications:store.get().notifications.filter(item=>item.userId===req.user.id),sharingPaused:store.get().household.sharingPaused}));
app.get('/api/household/consents',auth,roles('recipient'),(req,res)=>res.json({consents:safeHousehold().consents}));
app.post('/api/household/consents',auth,roles('recipient'),(req,res)=>{
  const {caregiverId,approved}=req.body||{};if(!['priya','arjun'].includes(caregiverId)||typeof approved!=='boolean')return res.status(400).json({error:'INVALID_CONSENT'});
  store.mutate(state=>{state.household.consents[caregiverId]={...state.household.consents[caregiverId],approved,approvedAt:approved?clock.now().toISOString():null};});
  if(!approved)for(const alert of store.get().alerts.filter(item=>item.ownerId===caregiverId&&!['RESOLVED','EXHAUSTED'].includes(item.state))) {
    const owner=selectConsentedOwner(store.get());
    if(owner&&owner.id!==caregiverId){const next=updateAlert(alert,{state:'ESCALATED',ownerId:owner.id,ownerRole:owner.role,ackDeadlineAt:new Date(+clock.now()+store.get().household.ackWindowMin*60000).toISOString()});if(next){audit('alert_owner_reassigned',req.user,{alertId:next.id,ownerId:owner.id,reason:'consent_revoked'});notify(owner.id,'alert','CareLoop task reassigned to you.',next.id);}}
    else {const next=updateAlert(alert,{state:'EXHAUSTED',ownerId:null,ownerRole:null,ackDeadlineAt:null,reason:EXHAUSTED_TEXT});if(next)audit('alert_exhausted',null,{alertId:next.id,reason:'no_consented_caregiver'});}
  }
  audit('caregiver_consent_changed',req.user,{caregiverId,approved});res.json({caregiverId,approved});
});
app.post('/api/alerts/:id/ack',auth,roles('primary','backup'),(req,res)=>{
  if(!String(req.body?.note||'').trim())return res.status(400).json({error:'NOTE_REQUIRED'});
  return changeAlert(req,res,()=>({state:'ACKNOWLEDGED',acknowledgedAt:clock.now().toISOString(),task:true,note:String(req.body.note).slice(0,500)}));
});
app.post('/api/alerts/:id/resolve',auth,roles('primary','backup'),(req,res)=>{
  if(!String(req.body?.note||'').trim())return res.status(400).json({error:'NOTE_REQUIRED'});
  return changeAlert(req,res,()=>({state:'RESOLVED',resolvedAt:clock.now().toISOString(),confirmationSource:'caregiver',note:String(req.body.note).slice(0,500)}));
});
app.post('/api/alerts/:id/confirm-by-phone',auth,roles('primary','backup'),(req,res)=>{
  if(!String(req.body?.note||'').trim())return res.status(400).json({error:'NOTE_REQUIRED'});
  return changeAlert(req,res,()=>({state:'RESOLVED',resolvedAt:clock.now().toISOString(),confirmationSource:'caregiver_phone',note:String(req.body.note).slice(0,500)}));
});
function changeAlert(req,res,makeChanges) {
  const alert=store.get().alerts.find(item=>item.id===req.params.id);
  if(!alert)return res.status(404).json({error:'NOT_FOUND'});
  if(alert.ownerId!==req.user.id)return res.status(403).json({error:'NOT_OWNER'});
  const expectedVersion=Number.isInteger(req.body?.expectedVersion)?req.body.expectedVersion:alert.version;
  const updated=store.mutate(state=>{
    const index=state.alerts.findIndex(item=>item.id===alert.id);
    if(index<0)return null;
    const next=casTransition(state.alerts[index],expectedVersion,{...makeChanges(alert),updatedAt:clock.now().toISOString()});
    if(next)state.alerts[index]=next;return next;
  });
  if(!updated)return res.status(409).json({error:'VERSION_CONFLICT'});
  audit('alert_transition',req.user,{alertId:alert.id,state:updated.state});res.json({alert:updated});
}
app.post('/api/recipient/confirm',auth,roles('recipient'),(req,res)=>{
  const status=req.body?.status;if(!['ok','help'].includes(status))return res.status(400).json({error:'INVALID_STATUS'});
  const now=clock.now(),alert=ensureToday({force:true});
  if(!alert)return res.status(410).json({error:'HOUSEHOLD_DELETED'});
  if(['RESOLVED','EXHAUSTED'].includes(alert.state))return res.json({ok:true,alreadyClosed:true,message:'Thanks for checking in. Your family has received your response.'});
  const changes=status==='ok'?{state:'RESOLVED',decision:'CONFIRMED',task:false,confirmationSource:'recipient',resolvedAt:now.toISOString(),ackDeadlineAt:null}:
    {state:alert.state,decision:'RECIPIENT_HELP',task:true,priority:'urgent',reason:'Margaret asked for help.',ackDeadlineAt:new Date(+now+store.get().household.ackWindowMin*60000).toISOString()};
  const updated=updateAlert(alert,changes);
  if(!updated)return res.status(409).json({error:'VERSION_CONFLICT'});
  store.mutate(state=>state.confirmations[currentDay()]={status,at:now.toISOString()});
  audit('recipient_confirmation',req.user,{status,alertId:updated.id});
  for(const caregiver of store.get().users.filter(user=>['primary','backup'].includes(user.role)&&store.get().household.consents[user.id]?.approved))notify(caregiver.id,status==='help'?'urgent_help':'confirmation',status==='help'?'Margaret asked for help.':'Margaret checked in.',updated.id);
  res.json({ok:true,alert:updated});
});
app.post('/api/recipient/pause',auth,roles('recipient'),(req,res)=>{
  const paused=Boolean(req.body?.paused);store.mutate(state=>state.household.sharingPaused=paused);
  audit('sharing_pause_changed',req.user,{paused});res.json({paused});
});
app.delete('/api/household',auth,roles('recipient'),authorizeDelete);

function caregiverPage(ringMode,demoMode) {
  return `<h1>Good morning, Priya</h1><p class="chip" id="ringHealth">Ring: ${ringMode} - no sync yet</p><section class="card" aria-live="polite"><h2>Today’s family check</h2><p id="why">Checking for today’s alert…</p><div id="alerts"></div><p id="alertSource"></p><label for="careNote">Note for the family (required)</label><textarea id="careNote" required></textarea><button id="ack">Acknowledge</button><button id="resolve">Resolve with note</button><button id="phone">Confirm by phone</button><p id="careStatus" aria-live="polite"></p></section><section class="card"><h2>Timeline</h2><ul id="timeline"></ul></section>${demoMode?'<section class="card"><h2>Demo controls</h2><label for="speed">Clock speed</label><input id="speed" type="number" min="0.1" max="120" step="0.1" value="1"><button id="setSpeed">Set speed</button><button data-scenario="visitor">Visitor at door</button><button data-scenario="motion">Possible activity</button><button data-scenario="offline">Device offline</button><button data-scenario="recover">Device online</button><button data-scenario="token">Simulate token expiry</button><button data-scenario="disabled">Simulate motion disabled</button></section>':''}<p class="small">Ring signals may suggest activity but cannot establish that a person is safe. CareLoop never contacts emergency services.</p>`;
}
function recipientPage() {
  return `<h1>Good morning, Margaret</h1><section class="card recipient" aria-live="polite"><p>How are you feeling today?</p><button id="ok">I’m okay</button><button id="help" class="urgent">Need help</button><button id="read">Read this page aloud</button><p id="recipientStatus" aria-live="polite"></p><p id="recipientNotice" aria-live="polite"></p></section><section class="card"><h2>What your family can see today</h2><p>Your family sees whether you checked in, the status of any family task, and limited Ring event labels when sharing is on. Ring does not tell them whether you are okay.</p><label class="toggle"><input id="contrast" type="checkbox"> High contrast</label><button id="pause">Pause sharing</button><button id="resume">Resume sharing</button><button id="delete" class="urgent">Delete household data</button><p>No emergency services are contacted by CareLoop.</p></section>`;
}
function sourcesPage(){return `<h1>Evidence sources</h1><p>Fixtures are synthetic samples. Simulator events are synthetic even when carried through the signed webhook receiver. <code>ring_api</code> events come from Ring only when Playground mode is configured and a successful API sync occurs. <code>webhook</code> means a signed incoming Ring webhook; no event source establishes that a resident is safe.</p><section class="card"><table><thead><tr><th>Source</th><th>Events</th><th>Meaning</th></tr></thead><tbody id="sourceRows"></tbody></table></section><p>CareLoop never accesses video, media, or snapshots. Ring evidence never closes an alert.</p>`;}
function renderPage(page) {
  const content=page==='recipient'?recipientPage():page==='sources'?sourcesPage():caregiverPage(mode,demo);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CareLoop · ${page}</title><link rel="stylesheet" href="/style.css"></head><body><header><a href="/caregiver" class="brand">CareLoop</a><nav aria-label="Main navigation"><a href="/caregiver">Caregiver</a><a href="/recipient">Margaret</a><a href="/sources">Sources</a></nav></header><main>${demo?'<div class="banner">Demo time accelerated · fixture and simulated events are synthetic, not real Ring evidence.</div>':''}${content}</main><script src="/app.js" defer></script></body></html>`;
}
app.get(['/','/caregiver','/recipient','/sources'],(req,res)=>{
  const page=req.path==='/'?'caregiver':req.path.slice(1);sessionForPage(req,res,page);res.type('html').send(renderPage(page));
});
app.get('/style.css',(_req,res)=>res.type('text/css').send(css));
app.get('/app.js',(_req,res)=>res.type('application/javascript').send(js));
const css=`:root{font-family:system-ui,sans-serif;color:#102a31;background:#f3f8f7;font-size:18px}*{box-sizing:border-box}body{margin:0}header{background:#123f46;color:#fff;padding:1rem max(1rem,calc((100% - 960px)/2));display:flex;justify-content:space-between;gap:1rem;align-items:center}a{color:inherit}nav{display:flex;gap:1rem}main{max-width:900px;margin:2rem auto;padding:0 1rem}.brand{font-size:1.35rem;font-weight:800;text-decoration:none}.banner{background:#fff3cd;color:#302400;border:2px solid #694e00;padding:1rem;margin-bottom:1rem}.card{background:#fff;border:1px solid #547077;border-radius:12px;padding:1.25rem;margin:1rem 0}.recipient{font-size:1.35rem}button{min-height:48px;min-width:44px;padding:.7rem 1rem;margin:.4rem .35rem .2rem 0;border:2px solid #123f46;border-radius:8px;background:#14525b;color:#fff;font:inherit;cursor:pointer}button.urgent{background:#8c2828}input,textarea{display:block;width:100%;min-height:48px;padding:.6rem;font:inherit;border:2px solid #45656b;border-radius:6px;margin:.3rem 0 1rem}textarea{min-height:90px}label{font-weight:650}.chip{display:inline-block;border:1px solid #45656b;border-radius:99px;padding:.4rem .8rem}.small{font-size:.9rem}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:4px solid #f0a900;outline-offset:2px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #9baeb0;padding:.7rem}.contrast{background:#000;color:#fff}.contrast .card{background:#050505;color:#fff;border-color:#fff}.contrast button{border-color:#fff}html{scroll-behavior:smooth}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}`;
const js=`(()=>{const page=location.pathname.slice(1)||'caregiver';const headers={'Content-Type':'application/json'};const api=async(url,options={})=>{const response=await fetch(url,{...options,credentials:'same-origin',headers:{...headers,...options.headers}});let data={};try{data=await response.json()}catch{}if(!response.ok){const safeRecipientMessage={ALERT_TERMINAL:'Thanks for checking in. Your family has received your response.',VERSION_CONFLICT:'Thanks for checking in. Your family has received your response.'};throw new Error(page==='recipient'?(safeRecipientMessage[data.error]||'We could not save that just now. Please try again.'):(data.error||'Request failed'))}return data};const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));let alertId=null,alertVersion=null;
if(page==='caregiver'){const status=document.querySelector('#careStatus');async function load(){try{const [a,t,h]=await Promise.all([api('/api/alerts'),api('/api/timeline'),api('/api/household')]);const current=a.alerts.at(-1);alertId=current?.id||null;alertVersion=current?.version??null;document.querySelector('#alerts').innerHTML=current?'<strong>'+esc(current.state)+' · '+esc(current.ownerId||'unassigned')+'</strong> · '+esc(current.decision):'No alert yet';document.querySelector('#why').textContent=current?.reason||'No current evidence has been recorded.';document.querySelector('#alertSource').textContent=current?.confirmationSource?'Confirmation recorded by: '+current.confirmationSource:'';document.querySelector('#timeline').innerHTML=t.events.map(event=>'<li>'+esc(event.ts)+' · '+esc(event.type)+' · '+esc(event.subType||'')+' ('+esc(event.source)+')</li>').join('');const health=h.household.ringHealth;const syncedAt=h.mode==='playground'?(health.lastSyncMode==='playground'?health.lastSyncAt:null):health.lastSyncAt;const age=syncedAt?Math.max(0,Math.round((Date.now()-Date.parse(syncedAt))/1000))+'s ago':'no successful sync';const household=h.household,playground=h.mode==='playground';const device=playground?health.error==='DEVICE_OFFLINE'||household.deviceOnline===false?'offline':syncedAt?'online':'unknown':household.deviceOnline?'online (synthetic)':'offline (simulated)';const motion=playground?health.error==='MOTION_DISABLED'||household.motionEnabled===false?'disabled':syncedAt?'enabled':'unknown':household.motionEnabled?'enabled (synthetic)':'disabled (simulated)';const setup=playground&&!h.ringConfigured?' · Playground not configured':'';document.querySelector('#ringHealth').textContent='Ring: '+h.mode+' · last sync '+age+' · device '+device+' · motion '+motion+setup+(health.error?' · '+health.error:'');}catch(error){status.textContent=error.message}}load();setInterval(load,5000);const act=async action=>{if(!alertId)return;const note=document.querySelector('#careNote').value.trim();if(!note){status.textContent='Add a note before continuing.';document.querySelector('#careNote').focus();return}try{await api('/api/alerts/'+alertId+'/'+action,{method:'POST',body:JSON.stringify({note,expectedVersion:alertVersion})});status.textContent='Update saved.';await load()}catch(error){status.textContent=error.message}};document.querySelector('#ack').onclick=()=>act('ack');document.querySelector('#resolve').onclick=()=>act('resolve');document.querySelector('#phone').onclick=()=>act('confirm-by-phone');document.querySelector('#setSpeed')?.addEventListener('click',async()=>{try{await api('/api/clock',{method:'POST',body:JSON.stringify({speed:Number(document.querySelector('#speed').value)})});status.textContent='Clock updated.'}catch(error){status.textContent=error.message}});document.querySelectorAll('[data-scenario]').forEach(button=>button.onclick=async()=>{try{await api('/api/demo/scenario',{method:'POST',body:JSON.stringify({kind:button.dataset.scenario})});status.textContent='Scenario added.';await load()}catch(error){status.textContent=error.message}})}
if(page==='recipient'){const status=document.querySelector('#recipientStatus');const notice=document.querySelector('#recipientNotice');const loadRecipient=async()=>{try{const data=await api('/api/recipient/status');const item=data.notifications.at(-1);if(item)notice.textContent=item.message}catch(error){notice.textContent=error.message}};loadRecipient();setInterval(loadRecipient,10000);document.querySelector('#ok').onclick=()=>sendConfirmation('ok');document.querySelector('#help').onclick=()=>sendConfirmation('help');async function sendConfirmation(value){try{const result=await api('/api/recipient/confirm',{method:'POST',body:JSON.stringify({status:value})});status.textContent=result.message||(value==='ok'?'Thanks for checking in.':'Your family has been asked to check in.')}catch(error){status.textContent=error.message}}document.querySelector('#read').onclick=()=>{if('speechSynthesis'in window)speechSynthesis.speak(new SpeechSynthesisUtterance(document.body.innerText));else status.textContent='Read-aloud is unavailable in this browser.'};document.querySelector('#contrast').onchange=event=>document.body.classList.toggle('contrast',event.target.checked);document.querySelector('#pause').onclick=()=>api('/api/recipient/pause',{method:'POST',body:JSON.stringify({paused:true})}).then(()=>status.textContent='Sharing paused.').catch(error=>status.textContent=error.message);document.querySelector('#resume').onclick=()=>api('/api/recipient/pause',{method:'POST',body:JSON.stringify({paused:false})}).then(()=>status.textContent='Sharing resumed.').catch(error=>status.textContent=error.message);document.querySelector('#delete').onclick=async()=>{if(!window.confirm('Delete household data?'))return;try{await api('/api/household',{method:'DELETE'});document.body.innerHTML='<main><h1>Deletion requested</h1><p>Household data was deleted; only the request tombstone remains.</p></main>'}catch(error){status.textContent=error.message}}}
if(page==='sources'){api('/api/sources').then(result=>{const labels={fixture:'Synthetic fixture sample',simulated:'Synthetic simulator event',ring_api:'Real Ring API metadata (Playground only)',webhook:'Signed incoming Ring webhook'};document.querySelector('#sourceRows').innerHTML=Object.entries(result.counts).map(([source,count])=>'<tr><td>'+esc(source)+'</td><td>'+count+'</td><td>'+esc(labels[source]||'Unknown source')+'</td></tr>').join('')||'<tr><td colspan="3">No events</td></tr>'}).catch(error=>document.querySelector('#sourceRows').innerHTML='<tr><td colspan="3">'+esc(error.message)+'</td></tr>')}})();`;

app.use((error,req,res,next)=>{
  if(req.path==='/ring/webhook'&&error.type==='entity.too.large')return res.status(200).json({ok:true});
  if(req.path==='/api/simulate/event'&&error.type==='entity.too.large')return res.status(413).json({error:'PAYLOAD_TOO_LARGE'});
  return res.status(500).json({error:'INTERNAL_ERROR'});
});

function sweep() {
  const now=clock.now();
  let alert=ensureToday();if(!alert)return;
  alert=alertForToday();if(!alert)return;
  const household=store.get().household;
  if(alert.decision==='MORNING_CHECK') {
    if(!alert.reminderSentAt&&+now>=+atLocalTime(now,household.tz,household.reminderAt)) {
      const changed=updateAlert(alert,{reminderSentAt:now.toISOString()});
      if(changed){for(const recipient of store.get().users.filter(user=>user.role==='recipient'))notify(recipient.id,'reminder','Please complete your morning check-in.',changed.id);audit('recipient_reminder_sent',null,{alertId:changed.id});alert=changed;}
    }
    if(+now>=+atLocalTime(now,household.tz,household.cutoff)) {
      const decision=decisionFor(store.get(),now);alert=applyDecision(alert,decision)||alert;
      if(decision.task)for(const user of store.get().users.filter(item=>['primary','backup'].includes(item.role)&&store.get().household.consents[item.id]?.approved))notify(user.id,'alert',`CareLoop ${decision.decision.toLowerCase()} task`,alert.id);
      if(decision.secondPrompt)for(const user of store.get().users.filter(item=>item.role==='recipient'))notify(user.id,'second_prompt','Please check in with your family.',alert.id);
    }
  }
  if(!['ASSIGNED','ESCALATED'].includes(alert.state))return;
  if(alert.promoteAt&&+now>=+new Date(alert.promoteAt)) {
    const changed=updateAlert(alert,{decision:'UNCONFIRMED',priority:'normal',task:true,ackDeadlineAt:new Date(+now+household.ackWindowMin*60000).toISOString(),promoteAt:null,reason:`${alert.reason} Follow-up deadline reached.`});
    if(changed)for(const user of store.get().users.filter(item=>['primary','backup'].includes(item.role)))notify(user.id,'alert','Possible activity follow-up became a task.',changed.id);
    return;
  }
  if(!alert.task)return;
  if(alert.ackDeadlineAt&&+now>=+new Date(alert.ackDeadlineAt)) {
    const currentOwner=store.get().users.find(user=>user.id===alert.ownerId);
    if(currentOwner&&inQuietHours(now,currentOwner.tz))audit('quiet_hour_skip',null,{caregiverId:currentOwner.id,alertId:alert.id});
    const backup=store.get().users.find(user=>user.role==='backup');
    if(alert.ownerRole!=='backup'&&backup&&store.get().household.consents[backup.id]?.approved&&!inQuietHours(now,backup.tz)) {
      const changed=updateAlert(alert,{state:'ESCALATED',ownerId:backup.id,ownerRole:'backup',ackDeadlineAt:new Date(+now+household.ackWindowMin*60000).toISOString()});
      if(changed){audit('alert_escalated',null,{alertId:changed.id,ownerId:backup.id});notify(backup.id,'alert','CareLoop task escalated to you.',changed.id);}
      return;
    }
    if(backup&&inQuietHours(now,backup.tz))audit('quiet_hour_skip',null,{caregiverId:backup.id,alertId:alert.id});
    const exhausted=updateAlert(alert,{state:'EXHAUSTED',ownerId:null,ownerRole:null,reason:EXHAUSTED_TEXT,ackDeadlineAt:null});
    if(exhausted){audit('alert_exhausted',null,{alertId:exhausted.id});for(const user of store.get().users.filter(item=>item.role==='recipient'))notify(user.id,'exhausted',EXHAUSTED_TEXT,exhausted.id);}
  }
}
const timer=setInterval(()=>{try{sweep();if(mode==='playground')syncRing();}catch{}},1000);timer.unref();
const port=Number(process.env.PORT)||3000;
if(require.main===module)app.listen(port,()=>console.log(`CareLoop listening on http://localhost:${port} (${mode})`));
module.exports={app,store,clock,signed,verifySignedPayload,processWebhook,ensureToday,sweep,syncRing,dataGapReason,ringClient,mode,demo,seedUsers,simulationEnabled,demoResetEnabled,syncHealthError,persistRefresh};
