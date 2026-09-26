import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
/** Compile repository source, not user/model content. No filesystem artifacts. */
export async function loadSource(file,bindings){
  const result=await build({entryPoints:[file],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',logLevel:'silent'});
  const module={exports:{}};
  const localRequire=id=>id==='cloudflare:workers' && bindings ? {env:bindings} : require(id);
  new Function('require','module','exports',result.outputFiles[0].text)(localRequire,module,module.exports);
  return module.exports;
}
