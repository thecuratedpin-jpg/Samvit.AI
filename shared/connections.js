// Only official API endpoints, plus an operator-configured OmniRoute gateway.
// Availability and account allowances vary; these labels are not unlimited-use promises.
export const CONNECTION_PROVIDERS = [
 {id:'openai',label:'OpenAI',kind:'direct',allowance:'Usage billed by provider',docs:'https://developers.openai.com/api/docs'},
 {id:'claude',label:'Anthropic',kind:'direct',allowance:'Usage billed by provider',docs:'https://platform.claude.com/docs'},
 {id:'gemini',label:'Google Gemini',kind:'direct',allowance:'Model and project dependent free allowance',docs:'https://ai.google.dev/gemini-api/docs/pricing'},
 {id:'grok',label:'xAI',kind:'direct',allowance:'Usage billed by provider',docs:'https://docs.x.ai'},
 {id:'openrouter',label:'OpenRouter',base:'https://openrouter.ai/api/v1',allowance:'Zero-price models with request limits',docs:'https://openrouter.ai/docs'},
 {id:'groq',label:'Groq',base:'https://api.groq.com/openai/v1',allowance:'Limited free plan; paid plans available',docs:'https://console.groq.com/docs/rate-limits'},
 {id:'cerebras',label:'Cerebras',base:'https://api.cerebras.ai/v1',allowance:'Check account allowance and limits',docs:'https://inference-docs.cerebras.ai'},
 {id:'mistral',label:'Mistral',base:'https://api.mistral.ai/v1',allowance:'Free experimentation limits vary',docs:'https://docs.mistral.ai'},
 {id:'deepseek',label:'DeepSeek',base:'https://api.deepseek.com/v1',allowance:'Usage billed by provider',docs:'https://api-docs.deepseek.com'},
 {id:'together',label:'Together AI',base:'https://api.together.xyz/v1',allowance:'Check account credit balance',docs:'https://docs.together.ai'},
 {id:'deepinfra',label:'DeepInfra',base:'https://api.deepinfra.com/v1/openai',allowance:'Check account credit balance',docs:'https://deepinfra.com/docs'},
 {id:'fireworks',label:'Fireworks AI',base:'https://api.fireworks.ai/inference/v1',allowance:'Check account credit balance',docs:'https://docs.fireworks.ai'},
 {id:'huggingface',label:'Hugging Face',base:'https://router.huggingface.co/v1',allowance:'Limited monthly credits, then paid usage',docs:'https://huggingface.co/docs/inference-providers/pricing'},
 {id:'nvidia',label:'NVIDIA NIM',base:'https://integrate.api.nvidia.com/v1',allowance:'Check model access and account limits',docs:'https://docs.api.nvidia.com/nim'},
 {id:'omniroute',label:'OmniRoute gateway',allowance:'Uses your gateway’s authorized connections and combos',docs:'https://github.com/diegosouzapw/OmniRoute'},
];
export const providerDefinition=id=>CONNECTION_PROVIDERS.find(p=>p.id===id);
export function validateCombo(input,connections) {
 if(typeof input?.name!=='string'||!input.name.trim()||input.name.length>60)throw new Error('Name the combo (up to 60 characters).');
 if(!Array.isArray(input.members)||input.members.length<2||input.members.length>4||new Set(input.members).size!==input.members.length)throw new Error('Choose 2–4 different connections in order.');
 if(input.members.some(id=>!connections.some(c=>c.id===id)))throw new Error('A combo connection no longer exists.');
 if(typeof input.freeOnly!=='boolean')throw new Error('Choose a free-only or paid-allowed policy.');
 if(input.freeOnly&&input.members.some(id=>!connections.find(c=>c.id===id)?.verifiedFree))throw new Error('Free-only combos need verified zero-price OpenRouter models.');
 if(!['priority','round-robin'].includes(input.strategy))throw new Error('Choose a supported routing strategy.');
 return {name:input.name.trim(),members:input.members,freeOnly:input.freeOnly,strategy:input.strategy};
}
