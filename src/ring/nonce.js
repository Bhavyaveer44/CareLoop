'use strict';
const crypto=require('node:crypto');
function computeNonce(key,time,accountId){return crypto.createHmac('sha256',key).update(`${time}:${accountId}`).digest('base64url');}
function validateNonce(key,time,accountId,signature,nowSeconds=Math.floor(Date.now()/1000)){
  const ts=Number(time); if(!Number.isFinite(ts)||Math.abs(nowSeconds-ts)>600||typeof signature!=='string') return false;
  const a=Buffer.from(computeNonce(key,ts,accountId)); const b=Buffer.from(signature);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
module.exports={computeNonce,validateNonce};
