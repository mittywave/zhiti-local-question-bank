import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadSource} from './load-source.mjs';
import {aiProviderModelsUrl,canReuseAiProviderKey,parseAiProviderModelCatalog,normalizeAiProviderApiBase} from '../lib/ai-provider-rules.mjs';

function memoryDb(){
  let row=null;
  return {
    get row(){return row;},set row(value){row=value;},
    prepare(sql){return {bind(...args){return {
      async first(){return row;},
      async run(){
        if(sql.includes('INSERT INTO ai_provider_config')){
          const names=['id','name','base_url','api_key_encrypted','wire_api','model_catalog_json','recognition_model','text_model','diagram_model','grading_model','enabled','updated_at'];
          row=Object.fromEntries(names.map((name,index)=>[name,args[index]]));
        }
        return {success:true};
      },
    };}};},
  };
}
const config={name:'test',baseUrl:'https://a.example/v1',apiKey:'test-only-secret',wireApi:'auto',modelCatalog:[{id:'test-model'}],recognitionModel:'test-model',textModel:'',diagramModel:'',gradingModel:'',enabled:true};
async function isolated(fn){
  const oldFetch=globalThis.fetch,env={...process.env};
  delete process.env.AI_PROVIDER_ENCRYPTION_KEY;delete process.env.OPENAI_API_KEY;
  const DB=memoryDb(),bindings={DB,LOCAL_ADMIN_MODE:'true'};
  try{await fn(await loadSource('lib/server/ai-provider.ts',bindings),DB,bindings);}
  finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
}
test('production cannot become local admin via URL, Host or forwarded/IP headers',async()=>{
  const bindings={DB:memoryDb(),LOCAL_ADMIN_MODE:'false'};
  const {isLocalRequest,currentUser}=await loadSource('lib/server/auth.ts',bindings);
  for(const url of ['https://public.example','http://localhost:3001','http://127.0.0.1','http://[::1]']){
    for(const headers of [{},{'X-Forwarded-Host':'localhost'},{Host:'localhost'},{'CF-Connecting-IP':'127.0.0.1'}]){
      const request=new Request(url,{headers});assert.equal(isLocalRequest(request),false);assert.equal(await currentUser(request),null);
    }
  }
  bindings.LOCAL_ADMIN_MODE='true';
  assert.equal(isLocalRequest(new Request('http://localhost:3001')),true);
  assert.equal(isLocalRequest(new Request('http://[::1]:3001')),true);
  assert.equal(isLocalRequest(new Request('http://public.example',{headers:{'X-Forwarded-Host':'localhost','CF-Connecting-IP':'127.0.0.1'}})),false);
  assert.equal(isLocalRequest(new Request('http://localhost:3001',{headers:{Host:'public.example'}})),false);
});
test('key reuse requires the same normalized endpoint, not merely the same origin',()=>{
  assert.equal(canReuseAiProviderKey('https://a.example/v1','https://a.example/v1/responses'),true);
  assert.equal(canReuseAiProviderKey('https://a.example/v1','https://b.example/v1'),false);
  assert.equal(canReuseAiProviderKey('https://a.example/one/v1','https://a.example/two/v1'),false);
  assert.equal(canReuseAiProviderKey('https://a.example/v1','http://a.example/v1'),false);
  assert.throws(()=>normalizeAiProviderApiBase('https://user:password@a.example'));
});
test('saving encrypts credentials and never returns plaintext',()=>isolated(async(provider,db)=>{
  const saved=await provider.saveAiProviderConfig(config);
  assert.equal(saved.hasApiKey,true);assert.equal(JSON.stringify(saved).includes(config.apiKey),false);
  assert.equal(db.row.api_key_encrypted.includes(config.apiKey),false);
  assert.equal((await provider.resolveAiRuntime('recognition')).apiKey,config.apiKey);
}));
test('changed discovery or save endpoint rejects saved key before any outbound request',()=>isolated(async(provider)=>{
  await provider.saveAiProviderConfig(config);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{id:'model'}]});};
  for(const baseUrl of ['https://b.example/v1','https://a.example/another/v1']){
    await assert.rejects(()=>provider.discoverAiProviderModels({baseUrl}),/重新输入/);
    await assert.rejects(()=>provider.saveAiProviderConfig({...config,baseUrl,apiKey:''}),/重新输入/);
  }
  assert.equal(calls,0);
}));
test('explicit new credential goes only to the new endpoint; old key remains unchanged during discovery',()=>isolated(async(provider)=>{
  await provider.saveAiProviderConfig(config);let received;
  globalThis.fetch=async(url,init)=>{received={url,init};return Response.json({data:[{id:'model'}]});};
  await provider.discoverAiProviderModels({baseUrl:'https://b.example/v1',apiKey:'new-test-secret'});
  assert.equal(received.url,'https://b.example/v1/models');assert.equal(received.init.headers.Authorization,'Bearer new-test-secret');
  assert.equal((await provider.resolveAiRuntime('text')).apiKey,config.apiKey);
}));
test('provider discovery never follows redirects with Authorization',()=>isolated(async(provider)=>{
  let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://other.example'}});};
  await assert.rejects(()=>provider.discoverAiProviderModels({baseUrl:config.baseUrl,apiKey:config.apiKey}),/重定向/);assert.equal(calls,1);
}));
test('enabled provider requires a model; corrupt enabled rows do not silently choose the environment vendor',()=>isolated(async(provider,db)=>{
  await assert.rejects(()=>provider.saveAiProviderConfig({...config,recognitionModel:''}),/至少选择/);
  await provider.saveAiProviderConfig(config);db.row.recognition_model='';process.env.OPENAI_API_KEY='environment-test-key';
  await assert.rejects(()=>provider.resolveAiRuntime('text'),/未切换/);
  db.row.enabled=0;assert.equal((await provider.resolveAiRuntime('text')).source,'environment');
}));
test('production requires HTTPS and an encryption secret; no encrypted or plaintext key reaches the public config',()=>isolated(async(provider,db,bindings)=>{
  bindings.LOCAL_ADMIN_MODE='false';
  await assert.rejects(()=>provider.saveAiProviderConfig({...config,baseUrl:'http://a.example'}),/HTTPS/);
  await assert.rejects(()=>provider.saveAiProviderConfig(config),/AI_PROVIDER_ENCRYPTION_KEY/);
  assert.equal(provider.aiProviderEncryptionReady(),false);
  bindings.AI_PROVIDER_ENCRYPTION_KEY='test-only-production-encryption-secret';
  await provider.saveAiProviderConfig(config);assert.equal(provider.aiProviderEncryptionReady(),true);
  assert.equal((await provider.resolveAiRuntime('recognition')).source,'database');assert.ok(db.row.api_key_encrypted);
}));
test('discovery respects Antigravity selection and parses both supported catalogs',()=>isolated(async(provider)=>{
  assert.equal(aiProviderModelsUrl('https://a.example/v1','antigravity_gemini'),'https://a.example/antigravity/v1beta/models');
  assert.deepEqual(parseAiProviderModelCatalog({models:[{name:'models/gemini-test',displayName:'Gemini'},{name:'models/gemini-test'}]}),[{id:'gemini-test',displayName:'Gemini'}]);
  globalThis.fetch=async(url)=>{assert.equal(url,'https://a.example/antigravity/v1beta/models');return Response.json({models:[{name:'models/gemini-test'}]});};
  const result=await provider.discoverAiProviderModels({baseUrl:config.baseUrl,apiKey:config.apiKey,wireApi:'antigravity_gemini'});assert.equal(result.models[0].id,'gemini-test');
}));
test('model discovery has a deadline and preserves caller cancellation',()=>isolated(async(provider)=>{
  process.env.AI_MODELS_TIMEOUT_MS='1000';
  globalThis.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  await assert.rejects(()=>provider.discoverAiProviderModels({baseUrl:config.baseUrl,apiKey:config.apiKey}),/exceeded/);
  const controller=new AbortController();const pending=provider.discoverAiProviderModels({baseUrl:config.baseUrl,apiKey:config.apiKey,signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
}));
test('drawing and assignment extraction no longer bypass database provider through legacy key guards',async()=>{
  for(const path of ['app/api/answer-studio/drawings/route.ts','lib/server/homework.ts']){
    const source=await readFile(path,'utf8');assert.doesNotMatch(source,/const apiKey\s*=\s*process\.env\.OPENAI_API_KEY/);
  }
});
