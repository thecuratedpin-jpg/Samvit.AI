// Team size is a subscription capability, never a browser-supplied entitlement.
export const TEAM_SIZES = Object.freeze({free:0,pro:2,ultra:3,ultimate:4});
export function teamSize(subscription) {
  return subscription?.status === 'active' ? TEAM_SIZES[subscription.planId] || 0 : 0;
}
export const TEAM_JOBS = [
  {id:'build',label:'Build & code',description:'Turn a specification into an implementation and review it.',roles:['Architect: clarify requirements and propose the structure.','Builder: develop the implementation using the brief.','Reviewer: identify bugs, edge cases and security issues.','Lead: reconcile the work into a complete, corrected deliverable.']},
  {id:'write',label:'Write & create',description:'Shape the idea, write the draft, then polish the result.',roles:['Strategist: identify the audience, goal and outline.','Writer: create a concrete draft using the brief.','Editor: improve clarity, accuracy and tone.','Creative lead: produce the final polished piece.']},
  {id:'study',label:'Learn & explain',description:'Break down a topic and check the explanation.',roles:['Tutor: explain the topic with a clear example.','Practice designer: create useful exercises and worked answers.','Checker: identify misconceptions and verify the explanation.','Study coach: assemble a concise learning guide.']},
  {id:'plan',label:'Plan & solve',description:'Explore options, check constraints and make a practical plan.',roles:['Planner: define the goal, constraints and possible approaches.','Analyst: compare options and propose concrete steps.','Reviewer: identify dependencies and failure cases.','Coordinator: deliver an actionable final plan.']},
  {id:'custom',label:'Your own team',description:'Give every agent a specific job.',roles:['Define the problem and prepare a useful first contribution.','Build on the first contribution and improve it.','Check the work and resolve weaknesses.','Combine the work into the final deliverable.']},
];
export function defaultRoles(jobId,count) {
  const job=TEAM_JOBS.find(j=>j.id===jobId)||TEAM_JOBS[0];
  return job.roles.slice(0,count).map((role,i)=>i===count-1?role+' Also synthesize the team’s work into the final answer.':role);
}
export function validateTeam(body,subscription) {
  const count=teamSize(subscription);
  if(!count) return {ok:false,status:403,error:'Agent teams require an active Pro, Ultra or Ultimate subscription.'};
  if(typeof body?.goal!=='string'||!body.goal.trim()||body.goal.length>6000) return {ok:false,status:400,error:'Enter a goal of 1–6000 characters.'};
  if(!Array.isArray(body.agents)||body.agents.length!==count) return {ok:false,status:403,error:`Your plan uses exactly ${count} agents.`};
  if(body.agents.some(a=>!a||typeof a.role!=='string'||!a.role.trim()||a.role.length>1000||typeof a.target!=='string'||a.target.length>300)) return {ok:false,status:400,error:'Choose a model and a job of 1–1000 characters for every agent.'};
  return {ok:true,count};
}
