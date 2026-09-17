// ==========================================================================
// SAMVIT V11 — VOICE INTERFACE (Phase 7)
// --------------------------------------------------------------------------
//   VOICE INPUT -> speech recognition -> Samvit core -> mission/action
//   system -> text response -> speech synthesis
//
// Two design rules drive this file:
//
//   1. NOT ALWAYS-ON. The microphone is opened only after an explicit user
//      action, and the wake phrase gates what is *acted on* — everything
//      else heard is discarded, never stored and never submitted.
//   2. VOICE IS NOT A PRIVILEGE ESCALATION PATH. A spoken command is
//      handed to exactly the same goal/mission pipeline as a typed one, so
//      it inherits the same grants, confirmation requirements, kill switch
//      and audit trail. There is no voice-only capability anywhere in this
//      module.
//
// The engine is pure logic with injected adapters, so it is unit-testable
// without a browser; `browserAdapters()` supplies the real Web Speech API
// implementations and is the only part that touches browser globals.
// ==========================================================================

export const DEFAULT_WAKE_PHRASE = 'hey samvit';
export const VOICE_STATES = Object.freeze(['off', 'idle', 'listening', 'awake']);

const normalize = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pure wake-phrase matcher.
 *
 * Returns whether the phrase was heard and, if so, the command that
 * followed it. Speech recognition frequently renders "Hey Samvit" as
 * "hey sam vid" or "hey samvit," — so matching is done on a normalised
 * letter/digit-only form rather than exact string equality.
 */
export function matchWakePhrase(transcript, phrase = DEFAULT_WAKE_PHRASE) {
  const heard = normalize(transcript);
  const target = normalize(phrase);
  if (!heard || !target) return {awake: false, command: ''};
  const index = heard.indexOf(target);
  if (index < 0) return {awake: false, command: ''};
  return {awake: true, command: heard.slice(index + target.length).trim()};
}

/** Trim model output to something worth speaking aloud. */
export function speakable(text, maxLength = 600) {
  const clean = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? clean.slice(0, maxLength).trimEnd() + '…' : clean;
}

/**
 * The voice engine. All browser interaction happens through the injected
 * `recognition` and `synth` adapters, which is what makes this testable.
 *
 * @param {object} options
 * @param {object} options.recognition  {start(), stop(), abort(), on(event, handler)}
 * @param {object} options.synth        {speak(text), cancel()}
 * @param {string} [options.wakePhrase]
 * @param {(text: string) => void} options.onCommand   submit a spoken goal
 * @param {(message: string) => void} [options.onStatus]
 */
export function createVoiceEngine({recognition, synth, wakePhrase = DEFAULT_WAKE_PHRASE, onCommand, onStatus = () => {}} = {}) {
  if (!recognition || typeof recognition.start !== 'function') throw Error('A recognition adapter is required');
  if (typeof onCommand !== 'function') throw Error('onCommand is required');

  let enabled = false;   // has the user opened the microphone?
  let awake = false;     // has the wake phrase been heard since the last command?
  let speaking = false;

  const status = message => onStatus(message);
  const state = () => (!enabled ? 'off' : speaking ? 'listening' : awake ? 'awake' : 'listening');

  function handleResult(transcript, isFinal) {
    // Interim results are only used to notice the wake phrase early; they are
    // never submitted, so a half-heard sentence cannot become a mission.
    const match = matchWakePhrase(transcript, wakePhrase);
    if (!awake) {
      if (!match.awake) return;              // heard, but not addressed to Samvit
      awake = true;
      status('Listening for your command.');
      if (!isFinal || !match.command) return;
    }
    if (!isFinal) return;
    const command = (awake && match.awake ? match.command : normalize(transcript)).trim();
    awake = false;
    if (!command) {status('Wake phrase heard, but no command followed.'); return;}
    status(`Command received: ${command}`);
    onCommand(command);
  }

  function handleError(reason) {
    if (reason === 'not-allowed' || reason === 'service-not-allowed') {
      enabled = false;
      status('Microphone permission was declined. Voice is off.');
      return;
    }
    if (reason === 'no-speech' || reason === 'aborted') return;
    status(`Voice input stopped (${reason}).`);
  }

  return {
    get state() {return state();},
    get enabled() {return enabled;},
    get awake() {return awake;},

    /** Explicit opt-in. Nothing listens before this is called. */
    enable() {
      if (enabled) return state();
      enabled = true;
      awake = false;
      recognition.start();
      status(`Voice on. Say "${wakePhrase}" followed by your request.`);
      return state();
    },

    /** Explicit opt-out — releases the microphone immediately. */
    disable() {
      enabled = false;
      awake = false;
      try {recognition.abort();} catch { /* adapter already stopped */ }
      try {synth?.cancel?.();} catch { /* nothing speaking */ }
      speaking = false;
      status('Voice off.');
      return state();
    },

    toggle() {return enabled ? this.disable() : this.enable();},

    /** Feed a recognition result. Called by the adapter. */
    result(transcript, isFinal = true) {handleResult(transcript, isFinal);},
    error(reason) {handleError(reason);},

    /** Speak a response aloud. No-op when voice is off, so nothing is ever read out unasked. */
    speak(text) {
      if (!enabled || !synth) return false;
      const utterance = speakable(text);
      if (!utterance) return false;
      speaking = true;
      try {synth.speak(utterance);} finally {speaking = false;}
      return true;
    },

    /** True when the browser can actually run this. */
    supported: true
  };
}

/** Real Web Speech API adapters. The only browser-dependent code in this file. */
export function browserAdapters() {
  const Recognition = typeof globalThis !== 'undefined' && (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  const synthesis = typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null;
  return {
    recognition: Recognition ? new Recognition() : null,
    synth: synthesis ? {speak: text => {
      const utterance = new globalThis.SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 0.98;
      synthesis.speak(utterance);
    }, cancel: () => synthesis.cancel()} : null,
    supported: Boolean(Recognition)
  };
}

/**
 * Wire the engine to a page. Idempotent and safe to call when the browser
 * has no speech support — it simply reports that voice is unavailable.
 */
export function installVoice({button, notify = () => {}, onCommand} = {}) {
  const {recognition, synth, supported} = browserAdapters();
  if (!supported || !recognition) {
    if (button) {button.disabled = true; button.title = 'Voice input is not supported in this browser.';}
    return {supported: false, engine: null};
  }
  // A wake-phrase listener must keep the session open across utterances;
  // everything else stays at the browser defaults.
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = globalThis.navigator?.language || 'en-US';

  const engine = createVoiceEngine({recognition, synth, onCommand, onStatus: notify});
  recognition.onresult = event => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      engine.result(result[0].transcript, Boolean(result.isFinal));
    }
  };
  recognition.onerror = event => engine.error(event.error);
  // The browser stops a continuous session on its own after silence; restart
  // it only while the user still has voice enabled.
  recognition.onend = () => {if (engine.enabled) {try {recognition.start();} catch { /* restart raced a manual stop */ }}};

  if (button) {
    button.onclick = () => {
      const state = engine.toggle();
      button.setAttribute('aria-pressed', String(state !== 'off'));
      button.classList.toggle('active', state !== 'off');
    };
  }
  return {supported: true, engine};
}
