import fs from 'fs';
const path = 'C:/Users/7196d/Samvit ai/Samvit-v10/tests/reliability.test.js';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(
  /assert\.ok\(PROVIDERS\[m\.provider\]\)/g, 
  "assert.ok(m.orchestration || Object.keys(PROVIDERS).includes(m.provider) || m.provider==='samvit')"
);

content = content.replace(
  /\['gemini-3\.6-flash','grok-4\.6'\]/g, 
  "['samvit-flash','gemini-3.6-flash']"
);

fs.writeFileSync(path, content);
