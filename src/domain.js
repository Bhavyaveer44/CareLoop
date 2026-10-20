'use strict';
const crypto=require('node:crypto');
const EXHAUSTED_TEXT='Nobody acknowledged. Suggested next step: contact a neighbor or local support service. CareLoop does not contact emergency services.';
function ringDataGapReason({mode='fixtures',health={},deviceOnline=true,motionEnabled=true,freshnessMin=30,now=new Date()}) {
  if(health.error==='APP_INTEGRATION_REMOVED')return 'Ring app integration was removed.';
  if(health.error==='TOKEN_INVALID'||health.error==='FORBIDDEN')return 'Ring authorization is unavailable.';
  if(health.error==='DEVICE_OFFLINE'||deviceOnline===false)return 'Ring device is offline.';
  if(health.error==='MOTION_DISABLED'||motionEnabled===false||health.motionEnabled===false||health.motionEnabled==='off')return 'Ring motion detection is disabled.';
  if(mode==='playground'&&(!health.lastSyncAt||+now-+new Date(health.lastSyncAt)>freshnessMin*60000))return 'Ring data is stale or has not synced recently.';
  if(!health.ok)return health.error||'Ring data is unavailable.';
  return null;
}
function classifyEvidence(events){const out=[];for(const e of events){if(e.type==='motion'){if(e.subType==='human')out.push({kind:'possible_activity',strength:'strong',text:'Possible activity detected by Ring (human classification).',event:e});else if(['vehicle','animal','other_motion'].includes(e.subType)){const labels={vehicle:'Vehicle activity detected — not resident evidence.',animal:'Animal activity detected — not resident evidence.',other_motion:'Other motion detected — not resident evidence.'};out.push({kind:'non_resident_activity',text:labels[e.subType],event:e});}else if(e.subType==='package_delivery')out.push({kind:'delivery',text:'Package-delivery activity noted.',event:e});else out.push({kind:'possible_activity',strength:'weak',text:'Unclassified motion detected; Smart Alerts may be off.',event:e});}
 else if(e.type==='doorbell_press')out.push({kind:'visitor',text:'Doorbell/button activity noted; this does not establish resident activity.',event:e});
 else if(e.type==='delivery'||e.subType==='package_delivery')out.push({kind:'delivery',text:'Package-delivery activity noted.',event:e});
 else if(e.type==='live_view')continue;else if(['device_offline'].includes(e.type))continue;}
 return out;}
function decideMorning({confirmed=false,dataGap=false,dataGapReason=null,events=[],now=new Date(),ackWindowMin=5,promoteAfterMin=60}){if(confirmed)return {decision:'CONFIRMED',state:'RESOLVED',task:false,close:true};if(dataGap)return {decision:'UNVERIFIABLE',state:'ASSIGNED',task:true,ackDeadlineAt:new Date(+now+ackWindowMin*60000).toISOString(),reason:dataGapReason||'Ring data is unavailable or stale.'};const evidence=classifyEvidence(events),activity=evidence.find(e=>e.kind==='possible_activity');if(!activity)return {decision:'UNCONFIRMED',state:'ASSIGNED',task:true,ackDeadlineAt:new Date(+now+ackWindowMin*60000).toISOString(),evidence};return {decision:'POSSIBLE_ACTIVITY',state:'ASSIGNED',task:false,priority:'low',secondPrompt:true,promoteAt:new Date(+now+promoteAfterMin*60000).toISOString(),evidence};}
function casTransition(alert,expectedVersion,changes){
 if(!alert||alert.version!==expectedVersion)return null;
 const allowed={ASSIGNED:new Set(['ASSIGNED','ACKNOWLEDGED','RESOLVED','ESCALATED','EXHAUSTED']),ACKNOWLEDGED:new Set(['ACKNOWLEDGED','ESCALATED','RESOLVED','EXHAUSTED']),ESCALATED:new Set(['ESCALATED','ACKNOWLEDGED','RESOLVED','EXHAUSTED']),RESOLVED:new Set(['RESOLVED']),EXHAUSTED:new Set(['EXHAUSTED'])};
 if(changes.state&&!allowed[alert.state]?.has(changes.state))return null;
 return {...alert,...changes,version:alert.version+1};
}
function newAlert(household,day,owner,decision,now){return {id:crypto.randomUUID(),householdId:household.id,dailyKey:`${household.id}#${day}`,state:decision.state,ownerId:owner?.id||null,ownerRole:owner?.role||null,version:0,createdAt:now.toISOString(),updatedAt:now.toISOString(),ackDeadlineAt:decision.ackDeadlineAt||null,promoteAt:decision.promoteAt||null,secondPrompt:Boolean(decision.secondPrompt),task:Boolean(decision.task),decision:decision.decision,reason:decision.reason||decision.evidence?.map(x=>x.text).join(' ')||'',evidence:decision.evidence||[],source:'fixture',confirmationSource:null,note:null,priority:decision.priority||'normal'};}
module.exports={classifyEvidence,decideMorning,casTransition,newAlert,ringDataGapReason,EXHAUSTED_TEXT};
