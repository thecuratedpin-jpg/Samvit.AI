import fs from 'fs';
const path = 'C:/Users/7196d/Samvit ai/Samvit-v10/netlify/lib/intelligence/model-call.js';
let content = fs.readFileSync(path, 'utf8');

// Inject options filter right after candidate generation
content = content.replace(
  /if\(!options\.length&&avoid\.length\)/, 
  "options = options.filter(m => !m.orchestration); if(!options.length&&avoid.length)"
);
// Also need to filter on the fallback candidates call
content = content.replace(
  /if\(!options\.length\)throw Error\('No eligible model is connected'\);/,
  "options = options.filter(m => !m.orchestration); if(!options.length)throw Error('No eligible model is connected');"
);

fs.writeFileSync(path, content);
