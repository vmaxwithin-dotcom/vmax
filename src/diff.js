// Bounded character diff: small edits use LCS; large edits use common prefix/suffix.
// Returns text operations only; UI renders with textContent, never HTML.
export function diffText(before, after) {
  const a = Array.from(before), b = Array.from(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length-p && s < b.length-p && a[a.length-1-s] === b[b.length-1-s]) s++;
  const x = a.slice(p,a.length-s), y = b.slice(p,b.length-s);
  const ops = [];
  const push = (type,text) => { if (!text) return; const last=ops.at(-1); if(last?.type===type) last.text+=text; else ops.push({type,text}); };
  push('equal',a.slice(0,p).join(''));
  if (x.length*y.length <= 300000 && x.length+y.length < 4000) {
    const table=Array.from({length:x.length+1},()=>new Uint16Array(y.length+1));
    for(let i=x.length-1;i>=0;i--) for(let j=y.length-1;j>=0;j--) table[i][j]=x[i]===y[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
    let i=0,j=0;
    while(i<x.length||j<y.length) {
      if(i<x.length&&j<y.length&&x[i]===y[j]) {push('equal',x[i++]);j++;}
      else if(j<y.length&&(i===x.length||table[i][j+1]>=table[i+1][j])) push('add',y[j++]);
      else push('remove',x[i++]);
    }
  } else { push('remove',x.join('')); push('add',y.join('')); }
  push('equal',s?a.slice(a.length-s).join(''):'');
  return ops;
}
