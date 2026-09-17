import fs from 'fs';
const path = 'C:/Users/7196d/Samvit ai/Samvit-v10/netlify/lib/intelligence/planning.js';
let content = fs.readFileSync(path, 'utf8');

// Update specSchema complexity and strategy and added verification_level
content = content.replace(
  /enum:\['low','medium','high'\]\}?(?=\,freshness_required)/,
  "enum:['TRIVIAL','SIMPLE','MODERATE','COMPLEX','MISSION','CRITICAL']}"
);
content = content.replace(
  /enum:\['single','specialists','consensus','critique','debate'\]/,
  "enum:['SINGLE','SPECIALIST_DELEGATION','PARALLEL_ANALYSIS','CONSENSUS','CRITIQUE','DEBATE','VERIFICATION','SYNTHESIS']"
);
content = content.replace(
  /needs_verification:\{type:'boolean'\}/,
  "verification_level:{...text(),enum:['NONE','BASIC','STANDARD','DEEP','CRITICAL']}"
);

// We need to implement the Phase -> Submission -> Task schema.
// We'll replace nodeSchema and planSchema entirely.
const newSchema = `
const taskSchema=object({id:{...text(32),pattern:'^[a-z][a-z0-9_-]*$'},description:{...text(2000),minLength:1},kind:{...text(),enum:['work','verify','synthesis']},capability:{...text(),enum:['general','reasoning','coding','research','writing']},tools:{type:'array',items:text(64),maxItems:8}});
const subMissionSchema=object({id:{...text(32),pattern:'^[a-z][a-z0-9_-]*$'},title:text(160),tasks:{type:'array',items:taskSchema,minItems:1,maxItems:4}});
const phaseSchema=object({id:{...text(32),pattern:'^[a-z][a-z0-9_-]*$'},title:text(160),dependencies:{type:'array',items:text(32),maxItems:7},subMissions:{type:'array',items:subMissionSchema,minItems:1,maxItems:4}});
export const planSchema=object({phases:{type:'array',items:phaseSchema,minItems:1,maxItems:8}});
`;
content = content.replace(/const nodeSchema=[\s\S]+?export const planSchema=[^\n]+;/, newSchema.trim());

fs.writeFileSync(path, content);
