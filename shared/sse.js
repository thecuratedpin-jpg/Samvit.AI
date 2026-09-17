/** WHATWG event framing: UTF-8, LF/CR/CRLF, multi-line data, chunk boundaries. */
export async function* iterateSSE(response) {
  if (!response.body) throw new Error('The response has no stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = 'message', data = [], skipLF = false;
  function line(value) {
    if (value === '') {
      const out = data.length ? {event, data:data.join('\n')} : null;
      event = 'message'; data = []; return out;
    }
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0,colon);
    let val = colon < 0 ? '' : value.slice(colon+1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (key === 'data') data.push(val);
    if (key === 'event') event = val;
    return null;
  }
  try {
    while (true) {
      const {value,done} = await reader.read();
      if (done) break; // Un-dispatched events at EOF are intentionally discarded.
      for (const char of decoder.decode(value,{stream:true})) {
        if (skipLF) { skipLF = false; if (char === '\n') continue; }
        if (char === '\n' || char === '\r') {
          const out = line(buffer); buffer = ''; skipLF = char === '\r';
          if (out) yield out;
        } else buffer += char;
        if (buffer.length > 2_000_000) throw new Error('Stream event exceeds the size limit.');
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}
