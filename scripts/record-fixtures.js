'use strict';
// Sanitizes a JSON response before it is saved as a playground fixture.
const fs=require('node:fs');
function sanitize(value,key=''){
 if(Array.isArray(value))return value.map(v=>sanitize(v,key));
 if(value&&typeof value==='object'){const out={};for(const [k,v] of Object.entries(value)){if(/token|secret|email|name|authorization/i.test(k)){out[k]=/name/i.test(k)?'Sanitized device':null;continue;}out[k]=sanitize(v,k);}return out;}
 if(typeof value==='string'&&/Bearer\s|@/.test(value))return '[redacted]';return value;
}
if(require.main===module){const [input,output]=process.argv.slice(2);if(process.env.RING_MODE!=='playground'){console.error('Set RING_MODE=playground before recording Ring responses.');process.exitCode=2;}else if(!input||!output){console.error('Usage: RING_MODE=playground node scripts/record-fixtures.js input.json output.json');process.exitCode=2;}else{const clean=sanitize(JSON.parse(fs.readFileSync(input,'utf8')));clean.recorded=true;fs.writeFileSync(output,JSON.stringify(clean,null,2)+'\n',{mode:0o600});try{fs.chmodSync(output,0o600);}catch{}console.log('Sanitized fixture saved.');}}
module.exports={sanitize};
