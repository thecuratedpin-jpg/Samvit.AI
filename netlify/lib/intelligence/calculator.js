// Arithmetic parser, never eval/Function/VM. Finite scalar arithmetic only.
export function calculate(expression){
 if(typeof expression!=='string'||expression.length>500||!/^[\d\s.eE+*/()%^-]+$/.test(expression))throw Error('Use a bounded arithmetic expression');
 const tokens=expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/%^\-]/g)||[];let i=0,depth=0;
 if(tokens.join('')!==expression.replace(/\s/g,''))throw Error('Invalid token');
 function atom(){if(++depth>32)throw Error('Expression too deep');let n;const t=tokens[i++];if(t==='('){n=sum();if(tokens[i++]!==')')throw Error('Missing closing parenthesis');}else if(t==='+'||t==='-')n=(t==='-'?-1:1)*atom();else {n=Number(t);if(t===undefined||!Number.isFinite(n))throw Error('Invalid number');}depth--;return n;}
 function power(){if(tokens[i]==='+'||tokens[i]==='-'){const sign=tokens[i++];return (sign==='-'?-1:1)*power();}let n=atom();if(tokens[i]==='^'){i++;n=n**power();}return n;}
 function product(){let n=power();while(['*','/','%'].includes(tokens[i])){const op=tokens[i++],b=power();n=op==='*'?n*b:op==='/'?n/b:n%b;}return n;}
 function sum(){let n=product();while(['+','-'].includes(tokens[i])){const op=tokens[i++],b=product();n=op==='+'?n+b:n-b;}return n;}
 const result=sum();if(i!==tokens.length||!Number.isFinite(result))throw Error('Invalid or non-finite calculation');return {expression,result};
}
export function arithmeticRequest(goal){const expression=goal.trim().replace(/^(?:what(?:'s| is)|calculate|compute)\s+/i,'').replace(/[?=]\s*$/,'').trim();if(!/[+*/%^\-]/.test(expression))return null;try{return calculate(expression);}catch{return null;}}
