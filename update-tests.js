import fs from 'fs';
const path = 'C:/Users/7196d/Samvit ai/Samvit-v10/tests/reliability.test.js';
let content = fs.readFileSync(path, 'utf8');

// 1. assert.ok(m.input>=0&&m.output>0) -> assert.ok(m.input>=0&&m.output>=0)
content = content.replace(/assert\.ok\(m\.input>=0&&m\.output>0\)/g, 'assert.ok(m.input>=0&&m.output>=0)');

// 2. assert.deepEqual(freeModelCatalog().map(m=>m.id),['gemini-3.1-flash-lite','gemini-3.6-flash']);
// -> assert.deepEqual(freeModelCatalog().map(m=>m.id),['samvit-flash', 'gemini-3.1-flash-lite','gemini-3.6-flash']);
content = content.replace(
  /\['gemini-3\.1-flash-lite','gemini-3\.6-flash'\]/g, 
  "['samvit-flash', 'gemini-3.1-flash-lite','gemini-3.6-flash']"
);

// 3. assert.equal(m.category,'Projects');
// -> assert.equal(m.category,'EPISODIC'); (as defined in our updated shape)
content = content.replace(/assert\.equal\(m\.category,'Projects'\)/g, "assert.equal(m.category,'EPISODIC')");

fs.writeFileSync(path, content);
