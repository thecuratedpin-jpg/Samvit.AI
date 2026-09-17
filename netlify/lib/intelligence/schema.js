// Deliberately small JSON-schema subset. Schemas are trusted and defined in source.
export function validate(value,schema,path='input') {
 if(schema.enum&&!schema.enum.includes(value))throw Error(`${path}: unsupported value`);
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${path}: expected object`);
  for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error(`${path}.${k}: required`);
  for(const [k,v]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(k)||!Object.hasOwn(schema.properties||{},k))throw Error(`${path}.${k}: unexpected field`);validate(v,schema.properties[k],path+'.'+k);}
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length>(schema.maxItems??100)||value.length<(schema.minItems??0))throw Error(`${path}: invalid array`);
  value.forEach((v,i)=>validate(v,schema.items,path+'['+i+']'));
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length>(schema.maxLength??20000)||value.length<(schema.minLength??0)||schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error(`${path}: invalid text`);
 }else if(schema.type==='number'||schema.type==='integer'){
  if(!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw Error(`${path}: invalid number`);
 }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error(`${path}: expected boolean`);}
 else throw Error('Unsupported schema type');
 return value;
}
export const text=(maxLength=2000)=>({type:'string',maxLength});
export const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export function parseJSON(raw){if(typeof raw!=='string'||raw.length>50000)throw Error('Structured output too large');return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}
