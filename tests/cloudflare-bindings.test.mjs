import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';
import {ensureLocalBindings} from '../scripts/local-binding-config.mjs';
test('Cloudflare binding customization preserves existing production bindings without concatenating duplicates',()=>{
  const config={d1_databases:[{binding:'DB',database_id:'existing-id',database_name:'existing',migrations_dir:'migrations'}],r2_buckets:[{binding:'HOMEWORK_ASSETS',bucket_name:'existing-assets'}],compatibility_flags:['nodejs_compat']};
  ensureLocalBindings(config,{d1:null,r2:null});ensureLocalBindings(config,{d1:null,r2:null});
  assert.equal(config.d1_databases.length,1);assert.equal(config.d1_databases[0].database_id,'existing-id');assert.equal(config.d1_databases[0].migrations_dir,'migrations');assert.equal(config.r2_buckets.length,1);assert.equal(config.compatibility_flags.length,1);
});
test('preview bindings are added only when missing',()=>{
  const config={};ensureLocalBindings(config,{d1:'preview-db',r2:'preview-assets'});ensureLocalBindings(config,{d1:'preview-db',r2:'preview-assets'});
  assert.equal(config.d1_databases.length,1);assert.equal(config.r2_buckets.length,1);assert.equal(config.d1_databases[0].binding,'preview-db');
});
test('built deployment config has exactly one database and homework asset binding',async()=>{
  const config=JSON.parse(await readFile(new URL('../dist/server/wrangler.json',import.meta.url),'utf8'));
  assert.equal(config.d1_databases.filter(item=>item.binding==='DB').length,1);
  assert.equal(config.r2_buckets.filter(item=>item.binding==='HOMEWORK_ASSETS').length,1);
});
