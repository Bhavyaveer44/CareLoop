'use strict';
function createClock() {
  let offsetMs = 0, speed = 1, anchorReal = Date.now(), anchorDemo = anchorReal;
  const now = () => new Date(anchorDemo + (Date.now() - anchorReal) * speed);
  function configure(input = {}) {
    const current = now().getTime(); anchorReal = Date.now(); anchorDemo = current;
    if (Number.isFinite(input.offsetMs)) {anchorDemo += input.offsetMs-offsetMs;offsetMs=input.offsetMs;}
    if (Number.isFinite(input.speed)) speed = Math.max(0.1, Math.min(120, input.speed));
    return state();
  }
  const state = () => ({now: now().toISOString(), offsetMs, speed});
  return {now, configure, state};
}
function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(date);
  return Number(parts.find(p=>p.type==='hour').value)*60 + Number(parts.find(p=>p.type==='minute').value);
}
function inQuietHours(date, timeZone, start='22:00', end='07:00') {
  const m = localMinutes(date,timeZone), [sh,sm]=start.split(':').map(Number), [eh,em]=end.split(':').map(Number);
  const a=sh*60+sm,b=eh*60+em;
  return a>b ? (m>=a || m<b) : (m>=a && m<b);
}
function atLocalTime(date, timeZone, hhmm) {
  const key=localDateKey(date,timeZone), [hour,minute]=hhmm.split(':').map(Number);
  const target=Date.UTC(...key.split('-').map((n,i)=>i===1?Number(n)-1:Number(n)),hour,minute);
  let guess=target;
  for(let i=0;i<3;i++) {
    const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
    const vals=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    const represented=Date.UTC(Number(vals.year),Number(vals.month)-1,Number(vals.day),Number(vals.hour),Number(vals.minute));
    guess += target-represented;
  }
  return new Date(guess);
}
module.exports={createClock,localDateKey,localMinutes,inQuietHours,atLocalTime};
