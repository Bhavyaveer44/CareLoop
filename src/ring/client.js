'use strict';
const config=require('../../ring.config.json');

class RingError extends Error {
  constructor(code,status,retryAfter=null){super(code);this.name='RingError';this.code=code;this.status=status;this.retryAfter=retryAfter;}
}

function normalizeEvent(raw,deviceId,source='ring_api',humanIds=new Set()) {
  const a=raw.attributes||{};
  const rawType=a.event_type||raw.type;
  let type='unknown',subType=a.sub_type??null;
  if(rawType==='motion'||rawType==='motion.human'||['vehicle','animal','other_motion','package_delivery'].includes(rawType)) {
    if(rawType!=='motion'&&rawType!=='motion.human')subType=rawType;
    type='motion';subType=rawType==='motion.human'||humanIds.has(String(raw.id))?'human':(subType||'motion');
  } else if(rawType==='ding'||rawType==='button_press') type='doorbell_press';
  else if(rawType==='on_demand'||rawType==='live_view') type='live_view';
  else if(['device_online','device_offline','delivery'].includes(rawType)) type=rawType;
  const stamp=a.start??a.timestamp??null;
  const ts=typeof stamp==='number'?new Date(stamp).toISOString():stamp!==null&&stamp!==undefined?new Date(stamp).toISOString():null;
  return {id:String(raw.id||`${deviceId}-${ts}`),deviceId:String(deviceId),type,subType,ts,source};
}

function createRingClient({fetchImpl=fetch,getToken,baseUrl=config.baseUrl,tokenUrl=config.tokenUrl,refreshCredentials=()=>({}),persistRefresh=()=>{},clock=()=>Date.now()}={}) {
  let accessToken=process.env.RING_ACCESS_TOKEN||null;
  let rotatedAccessToken=null;
  let expiresAt=0;
  let refreshToken=process.env.RING_REFRESH_TOKEN||null;
  let rotatedRefreshToken=null;
  const credentials=()=>refreshCredentials()||{};
  const availableRefresh=()=>rotatedRefreshToken||refreshToken||credentials().refreshToken||null;

  async function refresh() {
    const c=credentials();
    const rotating=availableRefresh();
    if(!rotating||!c.clientId||!c.clientSecret) throw new RingError('TOKEN_INVALID',401);
    const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:rotating,client_id:c.clientId,client_secret:c.clientSecret});
    let response;
    try {response=await fetchImpl(tokenUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});}
    catch {throw new RingError('RING_UNAVAILABLE',0);}
    if(!response.ok) throw new RingError(response.status===403?'FORBIDDEN':'TOKEN_INVALID',response.status);
    const result=await response.json();
    if(!result.access_token||!result.refresh_token) throw new RingError('TOKEN_INVALID',502);
    rotatedAccessToken=result.access_token;
    rotatedRefreshToken=result.refresh_token;
    expiresAt=clock()+Number(result.expires_in||14400)*1000;
    persistRefresh({refresh_token:rotatedRefreshToken,expires_at:expiresAt});
    return rotatedAccessToken;
  }

  async function token() {
    if(rotatedAccessToken&&expiresAt&&clock()>=expiresAt-300000&&availableRefresh()) await refresh();
    if(rotatedAccessToken) return rotatedAccessToken;
    if(getToken) {const provided=getToken();if(provided)return provided;}
    if(accessToken&&expiresAt&&clock()>=expiresAt-300000&&availableRefresh()) return refresh();
    if(accessToken) return accessToken;
    if(availableRefresh()) return refresh();
    throw new RingError('TOKEN_INVALID',401);
  }

  async function request(url,alreadyRefreshed=false) {
    const bearer=await token();
    let response;
    try {response=await fetchImpl(url,{headers:{Authorization:`Bearer ${bearer}`,Accept:'application/vnd.api+json'}});}
    catch {throw new RingError('RING_UNAVAILABLE',0);}
    if(response.status===401&&!alreadyRefreshed&&availableRefresh()) {await refresh();return request(url,true);}
    if(response.status===401) throw new RingError('TOKEN_INVALID',401);
    if(response.status===403) throw new RingError('FORBIDDEN',403);
    if(response.status===429) throw new RingError('RATE_LIMITED',429,response.headers?.get?.('retry-after')||null);
    if(response.status===503) throw new RingError('DEVICE_OFFLINE',503);
    if(response.status>=500) throw new RingError('RING_UNAVAILABLE',response.status);
    if(!response.ok) throw new RingError('RING_ERROR',response.status);
    return response.json();
  }

  async function listDevices() {
    const json=await request(`${baseUrl}${config.paths.devices}`),included=json.included||[];
    return (json.data||[]).map(device=>{
      const relations=device.relationships||{};
      const related=rel=>{const id=relations[rel]?.data?.id;return included.find(item=>String(item.id)===String(id));};
      const status=related('status'),settings=related('configurations'),location=related('location');
      return {id:String(device.id),name:device.attributes?.name||'Ring device',online:status?.attributes?.online??null,
        motionEnabled:settings?.attributes?.motion_detection?.enabled??null,
        country:location?.attributes?.country||null,state:location?.attributes?.state||null};
    });
  }

  async function getStatus(id) {
    const json=await request(`${baseUrl}${config.paths.status.replace('{id}',encodeURIComponent(id))}`);
    return json.data?.attributes?.online;
  }
  async function getConfigurations(id) {return (await listDevices()).find(device=>device.id===String(id))||null;}

  async function getHistory(id,eventTypes='motion') {
    const types=Array.isArray(eventTypes)?eventTypes:[eventTypes];
    const responses=[];
    for(const type of types) {
      let next=`${baseUrl}${config.paths.history.replace('{id}',encodeURIComponent(id)).replace('{eventTypes}',encodeURIComponent(type))}`;
      const visited=new Set();
      while(next) {
        if(visited.has(next)) throw new RingError('PAGINATION_LOOP',502);
        visited.add(next);
        const parsed=new URL(next,baseUrl);
        if(parsed.origin!==new URL(baseUrl).origin||!parsed.pathname.startsWith('/v1/history/devices/'))throw new RingError('INVALID_PAGINATION_LINK',502);
        next=parsed.toString();
        const json=await request(next);
        responses.push({type,json});
        next=json.links?.next?new URL(json.links.next,next).toString():null;
      }
    }
    const humanIds=new Set(responses.filter(page=>page.type==='motion.human').flatMap(page=>(page.json.data||[]).map(item=>String(item.id))));
    const byId=new Map();
    for(const page of responses) for(const raw of page.json.data||[]) {
      const item=normalizeEvent(raw,id,'ring_api',humanIds);
      const old=byId.get(item.id);
      if(!old||item.subType==='human') byId.set(item.id,item);
    }
    return [...byId.values()].sort((a,b)=>Date.parse(b.ts||0)-Date.parse(a.ts||0));
  }

  return {
    listDevices,getStatus,getConfigurations,getHistory,
    getDeviceStatus:getStatus,
    getEventHistory:async(sinceISO)=>{
      const devices=await listDevices();
      const histories=await Promise.all(devices.map(device=>getHistory(device.id,['motion','motion.human'])));
      const since=sinceISO?Date.parse(sinceISO):-Infinity;
      return histories.flat().filter(item=>Date.parse(item.ts)>=since).sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts));
    },
    setAccessToken(value){accessToken=value;rotatedAccessToken=null;expiresAt=0;},
    getToken:token
  };
}

module.exports={createRingClient,normalizeEvent,RingError};
