import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {loadSource} from '../tests/load-source.mjs';
const {runStudioWindow,runStudioOrdered,studioConcurrencyState}=await loadSource('lib/answer-studio-concurrency.ts');
const delays=[150,10,10,10, 10,150,10,10, 10,10,150,10, 10,10,10,150, 150,10,10,10, 10,150,10,10];
const items=delays.map((_,i)=>i),limit=4;
async function measure(rolling){
  let active=0,peak=0,calls=0;const result=[];
  const worker=async i=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,delays[i]));active--;return i;};
  const state=studioConcurrencyState(limit),start=performance.now();
  if(rolling)await runStudioOrdered(items,worker,state,async value=>result.push(value),async()=>{});
  else for(let i=0;i<items.length;i+=limit)for(const entry of await runStudioWindow(items.slice(i,i+limit),worker,state))result.push(entry.value);
  assert.deepEqual(result,items);assert.equal(calls,items.length);assert.ok(peak<=limit);
  return {milliseconds:Math.round(performance.now()-start),requests:calls,peakConcurrency:peak};
}
const batch=await measure(false),rolling=await measure(true);
console.log(JSON.stringify({scope:'Synthetic mixed-latency scheduler only; NOT live-model OCR speed',pages:items.length,batch,rolling,reductionPercent:Number((100*(1-rolling.milliseconds/batch.milliseconds)).toFixed(1))},null,2));
