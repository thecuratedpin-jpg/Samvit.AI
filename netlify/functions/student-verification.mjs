import {authorize,json,readBody,nodeEnv as env} from '../lib/new-api.js';
import {studentDiscountStatus} from '../lib/student-eligibility.js';
import {beginStudentVerification,refreshStudentVerification} from '../lib/sheerid.js';
export default async(req,context)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed.'},405);
 const {auth,response}=await authorize(req,env,context);if(response)return response;
 if(req.method==='GET')return json(await studentDiscountStatus(auth.accountId,env));
 if(auth.open)return json({error:'Create an account to request verification.'},403);
 try{const body=await readBody(req,1000);if(body.action==='request')return json(await beginStudentVerification(auth.accountId,env));if(body.action==='refresh'){await refreshStudentVerification(auth.accountId,env);return json({...await studentDiscountStatus(auth.accountId,env),message:'Verification status checked with SheerID.'});}return json({error:'Unknown verification action.'},400);}catch(e){return json({error:e.status===503?e.message:'Verification could not be confirmed. Use your verified Samvit email with SheerID, then retry.'},503);}
};export const config={path:'/api/student-verification'};
