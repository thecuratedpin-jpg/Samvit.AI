import {authorize,json,nodeEnv as env} from '../lib/new-api.js';
import {getFreeModels} from '../lib/free-models.js';
export default async(req,context)=>{if(req.method!=='GET')return json({error:'Method not allowed.'},405);const {response}=await authorize(req,env,context);if(response)return response;try{return json(await getFreeModels());}catch{return json({error:'The live free-model catalog is unavailable. Try again later.'},503);}};
export const config={path:'/api/free-models'};
