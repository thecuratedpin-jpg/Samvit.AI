import {PROVIDERS} from '../providers.js';
import {connectionRequest,classifyFailure} from '../connection-transport.js';
export function nativeRequest(provider,key,{model,history,system,tools=[],maxTokens=1536,env}){
 const messages=history.map(h=>({role:h.role==='tool'?'user':h.role,content:h.content||''}));
 const request=PROVIDERS[provider]?PROVIDERS[provider].buildRequest(key,{model,messages,system,maxTokens}):connectionRequest({provider,model},key,{messages,system,maxTokens},env);
 const body=JSON.parse(request.body);delete body.stream_options;body.stream=false;
 if(provider==='claude'){
  body.messages=history.map(h=>h.role==='tool'?{role:'user',content:[{type:'tool_result',tool_use_id:h.callId,content:h.content}]}:h.native&&h.nativeProvider===provider?{role:'assistant',content:h.native}:h.calls?.length?{role:'assistant',content:[...(h.content?[{type:'text',text:h.content}]:[]),...h.calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.arguments}))]}:{role:h.role,content:h.content});
  if(tools.length)body.tools=tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}));
 }else if(provider==='gemini'){
  request.url=request.url.replace(':streamGenerateContent?alt=sse',':generateContent');delete body.stream;
  body.contents=history.map(h=>h.role==='tool'?{role:'user',parts:[{functionResponse:{name:h.name,response:{result:h.content}}}]}:h.native&&h.nativeProvider===provider?{role:'model',parts:h.native}:h.calls?.length?{role:'model',parts:[...(h.content?[{text:h.content}]:[]),...h.calls.map(c=>({functionCall:{name:c.name,args:c.arguments}}))]}:{role:h.role==='assistant'?'model':'user',parts:[{text:h.content}]});
  if(tools.length)body.tools=[{functionDeclarations:tools.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.inputSchema}))}];
 }else{
  body.messages=[...(system?[{role:'system',content:system}]:[]),...history.map(h=>h.role==='tool'?{role:'tool',tool_call_id:h.callId,content:h.content}:h.calls?.length?{role:'assistant',content:h.content||null,tool_calls:h.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{role:h.role,content:h.content})];
  if(tools.length)body.tools=tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
 }
 return {...request,body:JSON.stringify(body)};
}
export function parseNative(provider,data){
 let content='',calls=[],native=null,usage=null,finish;
 if(provider==='claude'){
  finish=data.stop_reason;native=(data.content||[]).filter(x=>['text','tool_use'].includes(x.type));content=native.filter(x=>x.type==='text').map(x=>x.text).join('');calls=native.filter(x=>x.type==='tool_use').map(x=>({id:x.id,name:x.name,arguments:x.input}));
  if(data.usage)usage={inputTokens:data.usage.input_tokens+(data.usage.cache_creation_input_tokens||0)+(data.usage.cache_read_input_tokens||0),outputTokens:data.usage.output_tokens};
 }else if(provider==='gemini'){
  const c=data.candidates?.[0];finish=c?.finishReason;if(data.promptFeedback?.blockReason||['SAFETY','RECITATION','PROHIBITED_CONTENT','BLOCKLIST'].includes(finish))throw Object.assign(Error('Provider declined this request'),{reason:'safety'});
  native=(c?.content?.parts||[]).filter(p=>!p.thought);content=native.map(p=>p.text||'').join('');calls=native.filter(p=>p.functionCall).map((p,i)=>({id:p.functionCall.id||'call_'+i,name:p.functionCall.name,arguments:p.functionCall.args||{}}));
  if(data.usageMetadata)usage={inputTokens:data.usageMetadata.promptTokenCount,outputTokens:(data.usageMetadata.candidatesTokenCount||0)+(data.usageMetadata.thoughtsTokenCount||0)};
 }else{
  const c=data.choices?.[0],m=c?.message;finish=c?.finish_reason;if(m?.refusal||finish==='content_filter')throw Object.assign(Error('Provider declined this request'),{reason:'safety'});content=m?.content||'';calls=(m?.tool_calls||[]).map(c=>({id:c.id,name:c.function?.name,arguments:JSON.parse(c.function?.arguments||'{}')}));
  if(data.usage)usage={inputTokens:data.usage.prompt_tokens,outputTokens:data.usage.completion_tokens};
 }
 if(['length','max_tokens','MAX_TOKENS'].includes(finish))throw Object.assign(Error('Model output limit reached'),{reason:'truncated'});
 if(!finish||calls.length>6||typeof content!=='string'||content.length>16000||calls.some(c=>typeof c.id!=='string'||typeof c.name!=='string'||!c.arguments||typeof c.arguments!=='object'||Array.isArray(c.arguments)||JSON.stringify(c.arguments).length>24000))throw Error('Malformed model response');
 if(usage&&(!Number.isFinite(usage.inputTokens)||usage.inputTokens<0||!Number.isFinite(usage.outputTokens)||usage.outputTokens<0))usage=null;
 return {content,calls,native,usage};
}
export async function nativeCompletion(provider,key,params,{fetcher=fetch}={}){
 const request=nativeRequest(provider,key,params),signal=AbortSignal.any([params.signal,AbortSignal.timeout(30000)]);
 let response;try{response=await fetcher(request.url,{method:'POST',headers:request.headers,body:request.body,redirect:'error',signal});}catch{throw Object.assign(Error(signal.aborted?'Model stopped or timed out':'Provider connection failed'),{reason:'network',retryable:false});}
 const reader=response.body?.getReader();if(!reader)throw Error('Empty provider response');let bytes=0,raw='';const decoder=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>180000){await reader.cancel();throw Error('Provider response too large');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}
 let data;try{data=JSON.parse(raw);}catch{throw Error('Provider returned invalid JSON');}
 if(!response.ok){const fail=classifyFailure(response.status,data,response.headers);if(/safety|content_filter|refusal|policy_violation/i.test(String(data.error?.code||data.error?.type||''))){fail.reason='safety';fail.retryable=false;}else if(response.status===400||response.status===404){fail.reason='unsupported';fail.retryable=true;fail.rejected=true;}throw Object.assign(Error(fail.error),fail);}
 return parseNative(provider,data);
}
