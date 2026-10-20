'use strict';
const fs=require('node:fs'); const path=require('node:path');
function emptyState(){return {users:[],household:null,alerts:[],events:[],webhookRequests:[],audit:[],accessLog:[],notifications:[],confirmations:{},tombstone:null,clock:{offsetMs:0,speed:1}};}
function createStore({mode=process.env.STORE_MODE||'memory',file=process.env.DATA_FILE||'data/db.json'}={}) {
 let state=emptyState();
 if(mode==='json') {try{state=JSON.parse(fs.readFileSync(file,'utf8'));delete state.ringToken;}catch(e){if(e.code!=='ENOENT') throw e;}}
 const save=()=>{if(mode==='json'){fs.mkdirSync(path.dirname(file),{recursive:true});const safe=JSON.parse(JSON.stringify(state));delete safe.ringToken;delete safe.accessToken;delete safe.refreshToken;for(const user of safe.users||[]){delete user.token;delete user.testToken;delete user.bearerToken;}const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(safe,null,2),{mode:0o600});try{fs.chmodSync(tmp,0o600);}catch{}fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}};
 return {get:()=>state,replace(next){state=next;save();return state;},mutate(fn){const out=fn(state);save();return out;},reset(){state=emptyState();save();return state;},save};
}
module.exports={createStore,emptyState};
