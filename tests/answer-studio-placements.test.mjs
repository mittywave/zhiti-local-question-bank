import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const box={x:0,y:0,width:300,height:300};
const record=(answerPlacements,analysis='教师原文步骤',stem='')=>({lesson:'第一讲',section:'练习',number:'1',stem,analysis,box,diagramBoxes:[],answerPlacements,warnings:['原有提示'],continuation:false});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'studio-placements-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await build({entryPoints:['lib/answer-studio-contract.ts','lib/answer-studio-pipeline.ts','lib/answer-studio-layout.ts','lib/answer-studio-normalize.ts'],outdir:dir,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'});
  return Object.assign({},...['contract','pipeline','layout','normalize'].map(name=>require(join(dir,`answer-studio-${name}.cjs`))));
}

test('answer-only recognition retains short answers when placeholder metadata is empty or missing',async t=>{
  const {normalizeStudioRecords,normalizeStudioTextFields}=await fixture(t);
  for(const placeholder of ['', '　', null, undefined]){
    const [actual]=normalizeStudioRecords({records:[record([{kind:'blank',placeholder,answer:'$\\sqrt{10}$'}])]},'p','寒假');
    assert.equal(actual.analysis,'教师原文步骤\n$\\sqrt{10}$');
    assert.deepEqual(actual.answerPlacements,[]);
    assert.ok(actual.warnings.some(w=>w.includes('填入位置')));
    assert.ok(actual.warnings.includes('原有提示'));
    assert.deepEqual(normalizeStudioTextFields(actual),actual,'resuming must not duplicate salvaged answers');
  }
});

test('one invalid placement invalidates the entire mapping without dropping or shifting other answers',async t=>{
  const {normalizeStudioRecords,placeStudioAnswers}=await fixture(t);
  const placements=[{kind:'blank',placeholder:'____',answer:'$2$'},{kind:'unknown',placeholder:'____',answer:'$3$'}];
  const [actual]=normalizeStudioRecords({records:[record(placements,'原文证明','结果____，结果____。')]},'p','寒假');
  assert.deepEqual(actual.answerPlacements,[]);
  assert.equal(actual.analysis,'原文证明\n$2$\n$3$');
  assert.deepEqual(placeStudioAnswers(actual.stem,actual.answerPlacements).parts,[{text:actual.stem,red:false}]);
});

test('optional metadata defects cannot erase analysis or turn unknown answers into invented content',async t=>{
  const {normalizeStudioRecords}=await fixture(t);
  for(const malformed of [[null],[{kind:'blank',placeholder:'____',answer:''}],[{kind:'blank',answer:{value:'untrusted'}}]]){
    const [actual]=normalizeStudioRecords({records:[record(malformed,'完整原文\n第二步')]},'p','寒假');
    assert.equal(actual.analysis,'完整原文\n第二步');
    assert.deepEqual(actual.answerPlacements,[]);
    assert.ok(actual.warnings.some(w=>w.includes('短答案')));
  }
  const [numeric]=normalizeStudioRecords({records:[record({kind:'blank',answer:0},'（1）原文')]},'p','寒假');
  assert.equal(numeric.analysis,'（1）原文\n0','a literal numeric answer including zero is preserved without coercing objects');
  const [same]=normalizeStudioRecords({records:[record([{kind:'blank',placeholder:'',answer:'$7$'}],'$7$')]},'p','寒假');
  assert.equal(same.analysis,'$7$','an already complete answer line need not be duplicated');
});

test('valid choice/fill metadata and absent metadata remain unchanged; required text still fails closed',async t=>{
  const {normalizeStudioRecords,placeStudioAnswers}=await fixture(t);
  const placements=[{kind:'choice',placeholder:'（ ）',answer:'B'},{kind:'blank',placeholder:'____',answer:'$4$'}];
  const [valid]=normalizeStudioRecords({records:[record(placements,'原文','选择（ ），填空____。')]},'p','寒假');
  assert.deepEqual(valid.answerPlacements,placements);assert.deepEqual(valid.warnings,['原有提示']);
  assert.equal(placeStudioAnswers(valid.stem,valid.answerPlacements).parts.map(p=>p.text).join(''),'选择（B），填空$4$。');
  for(const empty of [undefined,null,[]])assert.deepEqual(normalizeStudioRecords({records:[record(empty)]},'p','寒假')[0].warnings,['原有提示']);
  assert.throws(()=>normalizeStudioRecords({records:[{...record([]),analysis:null}]},'p','寒假'),/文字结构/);
});
test('fills a blank inside a composite formula and keeps the working outside it',async t=>{
  const {placeStudioAnswers}=await fixture(t);
  const stem='分解因式：$(2a-b)^2+8ab=\\underline{\\quad}$。';
  const result=placeStudioAnswers(stem,[{kind:'blank',placeholder:'\\underline{\\quad}',answer:'$(2a+b)^2$'}]);
  assert.deepEqual(result.warnings,[]);
  assert.deepEqual(result.parts,[
    {text:'分解因式：$(2a-b)^2+8ab=$',red:false},
    {text:'$(2a+b)^2$',red:true,underline:true},
    {text:'。',red:false},
  ]);
  assert.equal(result.parts.filter(part=>part.red).map(part=>part.text).join(''),'$(2a+b)^2$');
});
test('normalizes and validates table cells without flattening the grid',async t=>{
  const {normalizeStudioRecords}=await fixture(t);
  const [recorded]=normalizeStudioRecords({records:[{...record([], '过程', '题干'), tables:[{rows:[['sin','$\\sqrt{2}$'],['','1']],warnings:[],red:true}]}]},'p','寒假');
  assert.deepEqual(recorded.tables,[{rows:[['sin','$\\sqrt{2}$'],['','1']],warnings:[],red:true}]);
  assert.throws(()=>normalizeStudioRecords({records:[{...record([], '过程', '题干'), tables:[{rows:[],warnings:[],red:false}]}]},'p','寒假'),/表格/);
});

test('page failures report the PDF page and resume without re-recognizing completed pages',async t=>{
  const {normalizeStudioRecords,transcribeStudio}=await fixture(t);
  const pages=[1,2].map(n=>({id:`p${n}`,name:'讲义.pdf',role:'answer',page:n,image:'evidence',hash:`p${n}`,selected:true}));
  const draft={version:1,inputMode:'answers',title:'寒假',pages,questions:[],answers:[],updatedAt:0};
  let last;
  const service={recognize:async p=>{
    if(p.page===2)throw new Error('识别服务暂时不可用');
    return normalizeStudioRecords({records:[{...record([],'第一页原文'),number:'1'}]},p.id,'寒假');
  },crop:async()=>({image:'evidence',width:300,height:300}),drawings:async()=>({warnings:[],diagrams:[]}),checkpoint:async d=>{last=d;},progress:()=>{}};
  await assert.rejects(()=>transcribeStudio(draft,service),/第 2 页.*识别服务暂时不可用.*已保(?:留|存)/s);
  assert.equal(last.pages[0].processed,true);assert.notEqual(last.pages[1].processed,true);
  const result=await transcribeStudio(last,{...service,recognize:async p=>{
    assert.equal(p.page,2);
    return normalizeStudioRecords({records:[{...record([{kind:'blank',placeholder:'',answer:'$8$'}],'第二页原文'),number:'2'}]},p.id,'寒假');
  }});
  assert.equal(result.questions.length,2);assert.equal(result.questions[1].analysis,'第二页原文\n$8$');
  assert.ok(result.pages.every(p=>p.processed));
});
