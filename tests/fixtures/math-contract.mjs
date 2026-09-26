export const mathContractSamples = [
  ['Inline and display size', 'The same expression $x=\\frac{1}{2}$ appears below.', String.raw`$$x=\frac{1}{2}$$`+'\n'+String.raw`$$\frac{\frac{1}{2}k_{CD}}{1+\frac{1}{2}k_{CD}}=\frac{4}{3}$$`],
  ['Arrows', 'Native editable symbols.', String.raw`$$a\leftarrow b\rightarrow c\leftrightarrow d\Leftarrow e\Rightarrow f\Leftrightarrow g$$`+'\n'+String.raw`$$\uparrow\downarrow\updownarrow\Uparrow\Downarrow\Updownarrow\nearrow\nwarrow\searrow\swarrow$$`+'\n'+String.raw`$$a\Longleftarrow b\Longrightarrow c\Longleftrightarrow d$$`],
  ['Matrices', 'All four entries remain distinct.', String.raw`$$\begin{matrix}1&20\\300&4\end{matrix}\quad\begin{pmatrix}1&2\\3&4\end{pmatrix}\quad\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`+'\n'+String.raw`$$\begin{vmatrix}1&2\\3&4\end{vmatrix}\quad\begin{Vmatrix}1&2\\3&4\end{Vmatrix}$$`],
  ['Array and rules', '右对齐加法竖式，以及带横线的多列表达式。', String.raw`$$\begin{array}{r}123\\+45\\\hline 168\end{array}$$`+'\n'+String.raw`$$\begin{array}{l@{\quad}cr}\hline a&b&c\\alpha&222&9\\\hline z&3&12345\\\hline\end{array}$$`],
  ['Nested grids', 'Balanced separators must not flatten nested grids.', String.raw`$$\begin{bmatrix}\begin{matrix}1&2\\3&4\end{matrix}&0\\0&\begin{cases}x=1\\y=2\end{cases}\end{bmatrix}$$`+'\n'+String.raw`$$\begin{aligned}x&=\frac{1}{2}\\y&=\begin{pmatrix}1&0\\0&1\end{pmatrix}\end{aligned}$$`],
];
export function mathContractDraft(){
  return {version:1,inputMode:'answers',title:'Math contract regression',pages:[],answers:[],updatedAt:0,questions:mathContractSamples.map(([section,stem,analysis],i)=>({id:`q${i}`,lesson:'Math contract regression',section,number:String(i+1),stem,analysis,questionSources:[],answerIds:[],diagrams:[],warnings:[],resolutions:{},reviewed:true,drawingsChecked:true,tables:[]}))};
}
