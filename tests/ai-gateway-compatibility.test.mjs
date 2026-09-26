import test from 'node:test';import assert from 'node:assert/strict';import {loadSource} from './load-source.mjs';
const input={role:'recognition',prompt:'Extract',schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}},required:['ok']},schemaName:'test'};
const response=(text='{"ok":true}')=>Response.json({output_text:text});
async function sandbox(fn){
  const fetch=globalThis.fetch,env={...process.env};
  process.env.OPENAI_API_KEY='test-key';process.env.OPENAI_BASE_URL='https://test.invalid';process.env.OPENAI_API_MODE='auto';process.env.OPENAI_VISION_MODEL='test-model';
  try{await fn(await loadSource('lib/server/ai-gateway.ts',{DB:{prepare:()=>({bind:()=>({first:async()=>null})})}}));}
  finally{globalThis.fetch=fetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
}
test('unsupported reasoning negotiates once without switching protocol or dropping schema',()=>sandbox(async({callStructuredAi})=>{
  const bodies=[];globalThis.fetch=async(url,init)=>{assert.ok(url.endsWith('/responses'));assert.equal(init.redirect,'manual');bodies.push(JSON.parse(init.body));return bodies.length===1?Response.json({error:{message:'Unsupported parameter: reasoning'}},{status:400}):response();};
  assert.equal((await callStructuredAi(input)).status,200);assert.equal(bodies.length,2);assert.ok(bodies[0].reasoning);assert.equal(bodies[1].reasoning,undefined);assert.equal(bodies[1].text.format.type,'json_schema');
}));
test('unsupported schema negotiates JSON mode and validates the returned structure',()=>sandbox(async({callStructuredAi})=>{
  let calls=0;globalThis.fetch=async(url,init)=>{calls++;const body=JSON.parse(init.body);if(calls===1)return Response.json({error:{message:'json_schema is not supported'}},{status:400});assert.equal(body.text.format.type,'json_object');assert.match(body.input[0].content[0].text,/schema/);return response();};
  assert.equal((await callStructuredAi(input)).text,'{"ok":true}');assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>++calls===1?Response.json({error:{message:'json_schema is not supported'}},{status:400}):response('{"wrong":1}');
  const invalid=await callStructuredAi(input);assert.equal(invalid.status,422);assert.equal(invalid.terminal,true);assert.equal(calls,2);
}));
test('combined optional capability reductions are bounded and preserve all images',()=>sandbox(async({callStructuredAi})=>{
  const bodies=[];globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);bodies.push(body);assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,AA==');
    if(body.reasoning)return Response.json({error:{message:'Unknown parameter reasoning'}},{status:400});
    if(body.text)return Response.json({error:{message:'text.format not supported'}},{status:422});return response();};
  assert.equal((await callStructuredAi({...input,images:['data:image/png;base64,AA==']})).status,200);assert.equal(bodies.length,4);
}));
test('schema mistakes, model failures, refusals and incomplete responses are not retried',()=>sandbox(async({callStructuredAi})=>{
  for(const payload of [{error:{message:'invalid schema'}},{error:{message:'unknown model'}},{status:'incomplete',output_text:'partial'},{output:[{content:[{type:'refusal',refusal:'no'}]}]}]){
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(payload,{status:payload.error?400:200});};const result=await callStructuredAi(input);assert.ok(result.status>=400);assert.equal(calls,1);
  }
}));
test('malformed HTTP 200 response falls back in auto mode; authentication and Retry-After never do',()=>sandbox(async({callStructuredAi})=>{
  const urls=[];globalThis.fetch=async url=>{urls.push(url);return url.endsWith('/responses')?new Response('<html>relay</html>'):Response.json({choices:[{message:{content:'{"ok":true}'}}]});};
  assert.equal((await callStructuredAi(input)).status,200);assert.equal(urls.length,2);
  for(const status of [401,403,408,429,503]){
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'try later'}},{status,headers:{'Retry-After':'10'}});};const result=await callStructuredAi(input);assert.equal(calls,1);assert.equal(result.status,status);assert.equal(result.retryAfter,'10');
  }
}));
test('both OpenAI protocols reject authenticated redirects',()=>sandbox(async({callStructuredAi})=>{
  for(const mode of ['responses','chat_completions']){
    process.env.OPENAI_API_MODE=mode;let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://other.invalid'}});};
    const result=await callStructuredAi(input);assert.equal(result.status,502);assert.match(result.error,/重定向/);assert.equal(calls,1);
  }
}));
test('the schema validator handles nested nullable structures and rejects unsupported validators',async()=>{
  const {matchesAiSchema}=await loadSource('lib/server/ai-schema.ts');
  const schema={type:'object',required:['items'],additionalProperties:false,properties:{items:{type:'array',items:{anyOf:[{type:'null'},{type:'number',minimum:0}]}}}};
  assert.equal(matchesAiSchema({items:[null,1]},schema),true);assert.equal(matchesAiSchema({items:[-1]},schema),false);assert.equal(matchesAiSchema({items:[],extra:1},schema),false);assert.equal(matchesAiSchema('x',{$ref:'#/missing'}),false);
});
test('native Antigravity requests retain schema, reasoning, image, deadline and redirect policy',()=>sandbox(async({callStructuredAi})=>{
  process.env.OPENAI_API_MODE='antigravity_gemini';
  let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://test.invalid/antigravity/v1beta/models/test-model:generateContent');assert.ok(init.signal);assert.equal(init.redirect,'manual');const body=JSON.parse(init.body);assert.equal(body.contents[0].parts[1].inlineData.mimeType,'image/png');assert.equal(body.generationConfig.responseMimeType,'application/json');return Response.json({candidates:[{content:{parts:[{text:'{"ok":'},{text:'true}'}]}}]});};
  const result=await callStructuredAi({...input,images:['data:image/png;base64,AA==']});assert.equal(result.text,'{"ok":true}');assert.equal(calls,1);
}));
test('missing configuration is terminal rather than repeatedly retried as a transient 503',()=>sandbox(async({callStructuredAi})=>{
  delete process.env.OPENAI_API_KEY;let calls=0;globalThis.fetch=async()=>{calls++;return response();};const result=await callStructuredAi(input);assert.equal(result.status,503);assert.equal(result.terminal,true);assert.equal(calls,0);
}));
