// SAMVIT V11 — voice interface tests. The engine is pure logic with injected
// adapters, so the wake-phrase gating and opt-in behaviour are exercised for
// real rather than asserted about a browser API that Node does not have.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceEngine,matchWakePhrase,speakable,installVoice,DEFAULT_WAKE_PHRASE} from '../src/voice.js';

function harness(overrides = {}) {
  const commands = [], statuses = [], spoken = [];
  const recognition = {started: false, aborted: false, cancelled: false, start() {this.started = true;}, stop() {}, abort() {this.aborted = true;}};
  const synth = {speak: text => spoken.push(text), cancel() {recognition.cancelled = true;}};
  const engine = createVoiceEngine({recognition, synth, onCommand: text => commands.push(text), onStatus: message => statuses.push(message), ...overrides});
  return {engine, recognition, synth, commands, statuses, spoken};
}

test('the default wake phrase is Hey Samvit and matching tolerates punctuation and casing',()=>{
 assert.equal(DEFAULT_WAKE_PHRASE,'hey samvit');
 assert.deepEqual(matchWakePhrase('Hey Samvit, summarize the report'),{awake:true,command:'summarize the report'});
 assert.deepEqual(matchWakePhrase('hey   SAMVIT'),{awake:true,command:''});
 assert.equal(matchWakePhrase('hello there, how are you').awake,false);
 assert.equal(matchWakePhrase('').awake,false);
 assert.equal(matchWakePhrase(null).awake,false);
 assert.equal(matchWakePhrase('hey samvit','computer').awake,false);
 assert.deepEqual(matchWakePhrase('computer, do it','computer'),{awake:true,command:'do it'});
});

test('spoken output is stripped of code, links and markup and is bounded',()=>{
 const text=speakable('# Title\n```js\nconst secret = 1;\n```\nSee https://example.com/x for **details**');
 assert.equal(text.includes('const secret'),false);
 assert.equal(text.includes('http'),false);
 assert.equal(text.includes('*'),false);
 assert.ok(text.includes('details'));
 assert.ok(speakable('a'.repeat(900)).length<=601);
 assert.equal(speakable(''),'');
});

test('voice is opt-in, and speech without the wake phrase is discarded',()=>{
 const h=harness();
 assert.equal(h.engine.state,'off');
 assert.equal(h.engine.enable(),'listening');
 assert.equal(h.recognition.started,true,'enabling is the only thing that opens the microphone');
 h.engine.result('what is the weather');
 h.engine.result('remind me to call the bank');
 assert.deepEqual(h.commands,[],'unaddressed speech must never become a mission');
 assert.equal(h.engine.awake,false);
 h.engine.result('Hey Samvit, what is the weather');
 assert.deepEqual(h.commands,['what is the weather']);
 assert.equal(h.engine.awake,false,'the wake phrase must be repeated for the next command');
 assert.equal(h.engine.disable(),'off');
 assert.equal(h.recognition.aborted,true);
});

test('the wake phrase can be spoken separately from the command it precedes',()=>{
 const h=harness();
 h.engine.enable();
 h.engine.result('Hey Samvit');
 assert.deepEqual(h.commands,[]);
 assert.equal(h.engine.awake,true,'the phrase arms the next utterance');
 h.engine.result('summarize the quarterly report');
 assert.deepEqual(h.commands,['summarize the quarterly report']);
 assert.equal(h.engine.awake,false);
});

test('interim recognition never becomes a mission',()=>{
 const h=harness();
 h.engine.enable();
 h.engine.result('Hey Samvit, delete every file',false);
 assert.deepEqual(h.commands,[],'a half-heard sentence must not be submitted');
 assert.equal(h.engine.awake,true);
 h.engine.result('Hey Samvit, delete every file',true);
 assert.deepEqual(h.commands,['delete every file']);
});

test('a custom wake phrase replaces the default',()=>{
 const h=harness({wakePhrase:'computer'});
 h.engine.enable();
 h.engine.result('Hey Samvit, do the thing');
 assert.deepEqual(h.commands,[]);
 h.engine.result('computer, do the thing');
 assert.deepEqual(h.commands,['do the thing']);
});

test('speech synthesis stays silent while voice is off and is bounded when on',()=>{
 const h=harness();
 assert.equal(h.engine.speak('Hello there'),false);
 assert.deepEqual(h.spoken,[]);
 h.engine.enable();
 assert.equal(h.engine.speak('Mission completed'),true);
 assert.deepEqual(h.spoken,['Mission completed']);
 assert.equal(h.engine.speak('   '),false,'whitespace is not worth speaking');
 assert.equal(h.engine.speak('x'.repeat(5000)).valueOf(),true);
 assert.ok(h.spoken.at(-1).length<=601);
});

test('a declined microphone turns voice off instead of retrying forever',()=>{
 const h=harness();
 h.engine.enable();
 h.engine.error('not-allowed');
 assert.equal(h.engine.enabled,false);
 assert.equal(h.engine.state,'off');
 assert.match(h.statuses.at(-1),/declined/);
 h.engine.enable();
 h.engine.error('no-speech');
 assert.equal(h.engine.enabled,true,'a transient error must not disable voice');
});

test('the engine refuses to be constructed without adapters or a command sink',()=>{
 assert.throws(()=>createVoiceEngine({}),/recognition adapter/);
 assert.throws(()=>createVoiceEngine({recognition:{start(){}},synth:null}),/onCommand/);
});

test('voice degrades gracefully when the browser has no speech support',()=>{
 const button={disabled:false,title:''};
 const result=installVoice({button,notify:()=>{}});
 assert.equal(result.supported,false);
 assert.equal(result.engine,null);
 assert.equal(button.disabled,true);
 assert.match(button.title,/not supported/);
});
