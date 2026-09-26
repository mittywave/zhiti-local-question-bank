import test from 'node:test';import assert from 'node:assert/strict';import {loadSource} from './load-source.mjs';
const input={prompt:'recognize',image:'data:image/png;base64,AA==',schema:{type:'object'},schemaName:'test'};
const ok=()=>Response.json({choices:[{message:{content:'{"ok":true}'}}]});
async function sandbox(fn){
  const fetch=globalThis.fetch,env={...process.env};
  process.env.OPENAI_API_KEY='test-only-key';process.env.OPENAI_VISION_MODEL='test-model';process.env.OPENAI_BASE_URL='https://transport.invalid/v1';process.env.OPENAI_API_MODE='auto';
  try{await fn(await loadSource('lib/server/recognition-model.ts',{DB:{prepare:()=>({bind:()=>({first:async()=>null})})}}));}finally{globalThis.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
}
test('auto mode remembers a successful chat-only endpoint instead of probing on every page',()=>sandbox(async({callRecognitionModel})=>{
  const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return String(url).endsWith('/responses')?Response.json({error:{message:'unsupported endpoint'}},{status:404}):ok();};
  await callRecognitionModel(input);await callRecognitionModel(input);
  assert.deepEqual(calls.map(s=>s.endsWith('/responses')), [true,false,false]);
}));
test('capability cache is scoped by credential, model and endpoint and expires',()=>sandbox(async({callRecognitionModel})=>{
  let probes=0;globalThis.fetch=async url=>{if(String(url).endsWith('/responses')){probes++;return new Response('{}',{status:405});}return ok();};
  await callRecognitionModel(input);process.env.OPENAI_API_KEY='another-key';await callRecognitionModel(input);
  process.env.OPENAI_VISION_MODEL='another-model';await callRecognitionModel(input);
  process.env.OPENAI_BASE_URL='https://second.invalid';await callRecognitionModel(input);
  assert.equal(probes,4);const now=Date.now;try{Date.now=()=>now()+601000;await callRecognitionModel(input);}finally{Date.now=now;}assert.equal(probes,5);
}));
test('auth, rate, server and schema errors never trigger a hidden second protocol request',()=>sandbox(async({callRecognitionModel})=>{
  for(const status of [400,401,403,429,500,502]){
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'invalid schema or unavailable model'}},{status,headers:{'Retry-After':'5'}});};
    const response=await callRecognitionModel(input);assert.equal(calls,1);assert.equal(response.status,status);assert.equal(response.retryAfter,'5');
  }
}));
test('auto mode falls back on empty success; explicit modes remain explicit',()=>sandbox(async({callRecognitionModel})=>{
  const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return String(url).endsWith('/responses')?Response.json({}):ok();};
  const result=await callRecognitionModel(input);assert.equal(result.status,200);assert.equal(calls.length,2);
  process.env.OPENAI_API_MODE='responses';const empty=await callRecognitionModel(input);assert.equal(empty.status,502);assert.equal(calls.length,3);assert.ok(calls[2].endsWith('/responses'));
  process.env.OPENAI_API_MODE='chat_completions';await callRecognitionModel(input);assert.equal(calls.length,4);assert.ok(calls[3].endsWith('/chat/completions'));
}));
test('response text blocks concatenate without dropping JSON suffixes',()=>sandbox(async({callRecognitionModel})=>{
  globalThis.fetch=async()=>Response.json({output:[{content:[{type:'output_text',text:'{"a":'},{type:'output_text',text:'1}'}]}]});
  assert.equal((await callRecognitionModel(input)).text,'{"a":1}');
}));
test('abort signals reach the provider request and cancellation is not cached',()=>sandbox(async({callRecognitionModel})=>{
  const controller=new AbortController();globalThis.fetch=async(url,{signal})=>new Promise((resolve,reject)=>{assert.ok(signal);if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  const pending=callRecognitionModel({...input,signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');
}));
test('per-attempt deadline returns a retryable timeout, not an indefinitely pending request',()=>sandbox(async({callRecognitionModel})=>{
  process.env.OPENAI_API_MODE='responses';process.env.RECOGNITION_TIMEOUT_MS='1000';
  globalThis.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const keepAlive=setTimeout(()=>{},2000);try{const result=await callRecognitionModel(input);assert.equal(result.status,504);assert.match(result.error,/completed pages/);}finally{clearTimeout(keepAlive);}
}));
