const fs = require('fs');
const src = fs.readFileSync('meeting-app/app.js','utf8');
let brace=0, paren=0, bracket=0; let line=1, col=0; let i=0;
let inSL=false, inML=false, inS=false, inD=false, inB=false; // //, /* */, ', ", 
let lastOpenPos = [];
function push(type){ lastOpenPos.push({type, line, col}); }
function pop(type){
  for (let j=lastOpenPos.length-1;j>=0;j--){ if (lastOpenPos[j].type===type){ lastOpenPos.splice(j,1); break; } }
}
for (; i<src.length; i++){
  const c = src[i]; const n = src[i+1];
  col++;
  if (c === '\n'){ line++; col=0; inSL=false; continue; }
  if (inSL){ continue; }
  if (inML){ if (c==='*' && n==='/' ){ inML=false; i++; col++; } continue; }
  if (inS){ if (c==='\\'){ i++; col++; continue;} if (c==="'"){ inS=false;} continue; }
  if (inD){ if (c==='\\'){ i++; col++; continue;} if (c==='"'){ inD=false;} continue; }
  if (inB){ if (c==='\\'){ i++; col++; continue;} if (c===''){ inB=false;} continue; }
  if (c==='/' && n==='/'){ inSL=true; i++; col++; continue; }
  if (c==='/' && n==='*'){ inML=true; i++; col++; continue; }
  if (c==="'"){ inS=true; continue; }
  if (c==='"'){ inD=true; continue; }
  if (c===''){ inB=true; continue; }
  if (c==='{'){ brace++; push('{'); }
  else if (c==='}'){ brace--; pop('{'); if (brace<0){ console.log('Extra } at',line,col); process.exit(0);} }
  else if (c==='('){ paren++; push('('); }
  else if (c===')'){ paren--; pop('('); if (paren<0){ console.log('Extra ) at',line,col); process.exit(0);} }
  else if (c==='['){ bracket++; push('['); }
  else if (c===']'){ bracket--; pop('['); if (bracket<0){ console.log('Extra ] at',line,col); process.exit(0);} }
}
console.log('Counts: {',brace,'} (',paren,') [',bracket,']');
console.log('Open stack tail:', lastOpenPos.slice(-10));
