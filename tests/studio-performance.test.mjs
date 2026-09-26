import test from 'node:test';import assert from 'node:assert/strict';import {loadSource} from './load-source.mjs';
const {runStudioOrdered,studioConcurrencyState}=await loadSource('lib/answer-studio-concurrency.ts');
const {studioPreparedImages}=await loadSource('lib/answer-studio-prepared-images.ts');
const turn=()=>new Promise(r=>setImmediate(r));
test('rolling scheduler refills a freed slot before a slow sibling completes, commits in order',async()=>{
  const release=[],started=[],committed=[],settled=[];
  const task=runStudioOrdered([0,1,2,3,4],n=>new Promise(resolve=>{started.push(n);release[n]=()=>resolve(n);}),studioConcurrencyState(2),async n=>committed.push(n),async n=>settled.push(n));
  await turn();assert.deepEqual(started,[0,1]);
  release[1]();await turn();assert.deepEqual(started,[0,1,2]);assert.deepEqual(committed,[]);
  release[2]();await turn();assert.deepEqual(started,[0,1,2,3]);
  release[3]();await turn();assert.equal(started.length,4,'lookahead is bounded while page zero blocks');
  release[0]();await turn();release[4]();await task;
  assert.deepEqual(committed,[0,1,2,3,4]);assert.equal(settled.length,5);
});
test('rolling failure drains started work and stops further launches',async()=>{
  const started=[],durable=[];let release;
  const task=runStudioOrdered([0,1,2,3],async n=>{started.push(n);if(!n){await turn();throw new Error('stop');}await new Promise(r=>release=r);return n;},studioConcurrencyState(2),async()=>{},async n=>durable.push(n));
  await turn();await turn();release();await assert.rejects(task,/stop/);
  assert.deepEqual(started,[0,1]);assert.deepEqual(durable,[1]);
});
test('prepared image cache shares retries and in-flight work, invalidates changed hashes',async()=>{
  let calls=0;const prepare=studioPreparedImages(async p=>{calls++;await turn();return p.hash;});
  const p={id:'page',hash:'a'};const first=prepare(p);assert.equal(first,prepare(p));await first;await prepare(p);assert.equal(calls,1);
  await prepare({...p,hash:'b'});assert.equal(calls,2);
});
test('prepared image cache does not retain rejection or oversized encoded images',async()=>{
  let calls=0;const prepare=studioPreparedImages(async()=>{if(++calls===1)throw new Error('decode');return '12345';},2,3);
  const p={id:'page',hash:'a'};await assert.rejects(prepare(p));await prepare(p);await prepare(p);assert.equal(calls,3);
});
test('prepared image cache uses a bounded LRU, not an unbounded document-sized store',async()=>{
  let calls=0;const prepare=studioPreparedImages(async p=>{calls++;return p.hash;},2,100);
  const p=n=>({id:String(n),hash:String(n)});
  await prepare(p(1));await prepare(p(2));await prepare(p(1));await prepare(p(3));await prepare(p(1));assert.equal(calls,3);
  await prepare(p(2));assert.equal(calls,4);
});
test('snapshot isolates mutable state without feeding source pixels into structuredClone',async()=>{
  const {studioSnapshot}=await loadSource('lib/answer-studio-snapshot.ts');
  const old=globalThis.structuredClone,seen=[];
  globalThis.structuredClone=value=>{seen.push(value);return old(value);};
  try{
    const source={version:1,title:'draft',updatedAt:0,pages:[{id:'p',hash:'h',image:'large-source-pixels'}],questions:[{id:'q',warnings:['keep'],diagrams:[{baseImage:'large-crop-pixels',shapes:[]}]}],answers:[]};
    const copy=studioSnapshot(source);
    assert.deepEqual(copy,source);assert.equal(seen[0].pages[0].image,'');assert.equal(seen[0].questions[0].diagrams[0].baseImage,'');
    copy.questions[0].warnings.push('new');copy.pages[0].processed=true;
    assert.deepEqual(source.questions[0].warnings,['keep']);assert.equal(source.pages[0].processed,undefined);
  }finally{globalThis.structuredClone=old;}
});
