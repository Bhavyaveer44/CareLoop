'use strict';
function shouldPoll(now,lastPoll,pollNotBefore){return now-lastPoll>=60000&&now>=pollNotBefore;}
function retryAfterMs(value,nowMs){if(!value)return 60000;const seconds=Number(value);if(Number.isFinite(seconds))return Math.max(0,seconds*1000);const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-nowMs):60000;}
function backoffMs(failures){return Math.min(15*60000,60000*(2**Math.min(Math.max(1,failures),4)));}
module.exports={shouldPoll,retryAfterMs,backoffMs};
