/** Cross-platform focused suite; do not depend on shell glob expansion. */
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const exact=new Set(['studio-performance.test.mjs','recognition-transport.test.mjs','math-contract-regression.test.mjs','math-export-repair.test.mjs','math-omml.test.mjs','recognition-contract.test.mjs']);
const files=readdirSync('tests').filter(name=>/^answer-studio-.*\.test\.mjs$/.test(name)||exact.has(name)).sort().map(name=>'tests/'+name);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
