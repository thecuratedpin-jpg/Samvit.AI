// Parse quoted fields before neutralizing formulas, then emit quoted CSV cells.
export function safeCSV(input){
 const rows=[],row=[];let cell='',quoted=false,closed=false;
 function finish(){row.push(cell);cell='';closed=false;}
 for(let i=0;i<input.length;i++){
  const c=input[i];
  if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c==='"'&&!cell&&!closed){quoted=true;continue;}
  if(c===','){finish();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&input[i+1]==='\n')i++;finish();rows.push(row.splice(0));continue;}
  if(closed||c==='"')throw Error('Malformed CSV quoting');cell+=c;
 }
 if(quoted)throw Error('Unterminated CSV field');
 if(cell||row.length||closed){finish();rows.push(row);}
 return rows.map(r=>r.map(v=>'"'+(/^[\s\uFEFF]*[=+@-]/u.test(v)?"'"+v:v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
}
