import {splitMathText} from './math-text-core.mjs';
/** Balanced TeX grid scanner; regexp splitting loses nested arrays and escapes. */
export function readMathGroup(text:string,start:number):{body:string;end:number} {
  if(text[start]!=='{')throw new Error('Expected a math group');
  let depth=1;
  for(let i=start+1;i<text.length;i++){
    if(text[i]==='\\'){i++;continue;}
    if(text[i]==='{')depth++;
    if(text[i]==='}'&&!--depth)return {body:text.slice(start+1,i),end:i+1};
  }
  throw new Error('Unclosed math group');
}
function tokenAt(text:string,i:number) {
  return /^\\(begin|end)\s*\{([A-Za-z]+)\}/.exec(text.slice(i));
}
export function readMathEnvironment(text:string,start:number,env:string):{body:string;end:number} {
  const stack=[env];
  for(let i=start;i<text.length;i++){
    if(text[i]!=='\\')continue;
    const literal=/^\\(?:text|textrm)\s*(?=\{)/.exec(text.slice(i));
    if(literal){i=readMathGroup(text,i+literal[0].length).end-1;continue;}
    const token=tokenAt(text,i);
    if(!token){if(!/[A-Za-z]/.test(text[i+1]??''))i++;continue;}
    if(token[1]==='begin'){
      stack.push(token[2]);if(stack.length>32)throw new Error('Math environment nesting exceeds 32');
    } else {
      if(stack.pop()!==token[2])throw new Error(`Mismatched math environment ${token[2]}`);
      if(!stack.length)return {body:text.slice(start,i),end:i+token[0].length};
    }
    i+=token[0].length-1;
  }
  throw new Error(`Unclosed math environment ${env}`);
}
export type MathGrid={rows:string[][];rules:Map<number,number>};
export function parseMathGrid(body:string,allowRules=false):MathGrid {
  const rows:string[][]=[],rules=new Map<number,number>();
  let cells:string[]=[],cell='';
  const finish=()=>{
    cells.push(cell.trim());
    if(cells.length>32||rows.length>=128)throw new Error('Math grid exceeds 128 rows or 32 columns');
    rows.push(cells);cells=[];cell='';
  };
  for(let i=0;i<body.length;i++){
    const c=body[i];
    if(c==='{'){const group=readMathGroup(body,i);cell+=body.slice(i,group.end);i=group.end-1;continue;}
    if(c==='}')throw new Error('Unexpected closing brace in math grid');
    if(c==='&'){cells.push(cell.trim());cell='';continue;}
    if(c==='\\'){
      if(body[i+1]==='\\'){finish();i++;if(/^\s*\[/.test(body.slice(i+1)))throw new Error('Custom math row spacing is not supported');continue;}
      const token=tokenAt(body,i);
      if(token){
        if(token[1]==='end')throw new Error('Unexpected math environment end');
        const region=readMathEnvironment(body,i+token[0].length,token[2]);cell+=body.slice(i,region.end);i=region.end-1;continue;
      }
      const rule=/^\\hline(?![A-Za-z])/.exec(body.slice(i));
      if(rule){
        if(!allowRules||cell.trim()||cells.length)throw new Error('hline is allowed only at an array row boundary');
        const count=(rules.get(rows.length)??0)+1;
        if(count>2)throw new Error('At most two horizontal rules per row boundary are supported');
        rules.set(rows.length,count);i+=rule[0].length-1;continue;
      }
      cell+=c;if(i+1<body.length)cell+=body[++i];continue;
    }
    cell+=c;
  }
  if(cell.trim()||cells.length)finish();
  if(!rows.length)throw new Error('Empty math grid');
  return {rows,rules};
}
export type ArrayColumn={align:'left'|'center'|'right';gap?:string};
export function parseArrayColumns(spec:string):ArrayColumn[] {
  const columns:ArrayColumn[]=[];
  for(let i=0;i<spec.length;i++){
    if(/\s/.test(spec[i]))continue;
    if('lcr'.includes(spec[i])){columns.push({align:spec[i]==='l'?'left':spec[i]==='r'?'right':'center'});continue;}
    if(spec[i]==='@'&&columns.length){
      const group=readMathGroup(spec,i+1),spacing=group.body.trim();
      const spaces:Record<string,string>={'':'','\\quad':'\u2003','\\qquad':'\u2003\u2003','\\,':'\u2009','\\:':'\u2005','\\;':'\u2004'};
      if(!(spacing in spaces))throw new Error(`Unsupported array inter-column material: @{${spacing}}`);
      columns[columns.length-1].gap=spaces[spacing];i=group.end-1;continue;
    }
    throw new Error(`Unsupported array column specification at ${i+1}: ${spec[i]}`);
  }
  if(!columns.length||columns.length>32)throw new Error('Array requires 1 to 32 l/c/r columns');
  if(columns.at(-1)?.gap)throw new Error('Trailing array spacing is not supported');
  return columns;
}

/** Ruled arrays are native Word tables, never fake underline/phantom rows.
 * Return only an entire standalone array; embedded/nested rules remain strict
 * compiler errors because a w:tbl cannot legally be placed inside m:oMath.
 */
export function standaloneRuledArray(source:string) {
  const text=source.trim(),start=/^\\begin\s*\{array\}\s*/.exec(text);
  if(!start)return null;
  const spec=readMathGroup(text,start[0].length),columns=parseArrayColumns(spec.body);
  const region=readMathEnvironment(text,spec.end,'array');
  if(region.end!==text.length)return null;
  const grid=parseMathGrid(region.body,true);
  if(!grid.rules.size)return null;
  if(grid.rows.some(row=>row.length>columns.length))throw new Error('Array column count does not match its specification');
  return {...grid,columns};
}

export function standaloneRuledArrayLine(text:string) {
  const segments=splitMathText(text).filter(s=>s.value.trim());
  if(segments.length!==1||segments[0].kind!=='math')return null;
  return standaloneRuledArray(segments[0].value);
}
