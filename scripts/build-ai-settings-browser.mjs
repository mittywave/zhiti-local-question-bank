import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(process.argv[2] || '.ai-settings-browser-test');await mkdir(out,{recursive:true});
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Page from './app/settings/ai/page';createRoot(document.getElementById('root')).render(<Page/>);`,loader:'tsx',resolveDir:process.cwd()},
  bundle:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',outfile:resolve(out,'app.js'),
  // Navigation itself is outside this isolated form regression; the settings
  // component, state transitions and HTTP calls are the real application code.
  plugins:[{name:'isolated-link',setup(build){
    build.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'test-navigation'}));
    build.onLoad({filter:/.*/,namespace:'test-navigation'},()=>({contents:`import React from 'react';export default function Link({href,children,...rest}){return React.createElement('a',{href,...rest},children);}`,loader:'js',resolveDir:process.cwd()}));
  }}],
  define:{'process.env.NODE_ENV':'"production"','process.env':'{}'},logLevel:'silent'});
await writeFile(resolve(out,'index.html'),'<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="app.js"></script></html>');
console.log(out);
