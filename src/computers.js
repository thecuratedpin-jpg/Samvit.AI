// ==========================================================================
// SAMVIT V12 — COMPUTERS (the desktop bridge UI)
// --------------------------------------------------------------------------
// Pairing, authorised folders, approved commands, revocation, and the
// decision queue for actions the policy engine returned ASK_USER for.
//
// Nothing on this page executes anything. It only manages authorisation and
// answers questions the agent asked.
// ==========================================================================
let generation = 0, selected = null;

export function stopComputers() { generation++; }

export async function renderComputers({main, api, esc, notify}) {
  stopComputers();
  const epoch = generation;
  const alive = () => epoch === generation && Boolean(document.querySelector('#computers-page'));
  const $ = selector => main.querySelector(selector);

  main.innerHTML = `<section id="computers-page" class="page">
   <div class="page-head"><div><div class="eyebrow">YOUR COMPUTERS</div><h1>Let Samvit work on a computer you own.</h1>
   <p class="intro">Pair a computer, authorise specific folders, and approve the development commands it may run. Samvit can never see or change anything outside the folders you authorise here.</p></div></div>
   <div class="panel"><h3>Pair a computer</h3>
   <p>Generate a single-use code, then run the agent on the computer you want to connect. The code expires in five minutes.</p>
   <div class="form-row"><button class="primary" id="pair-start">Generate a pairing code</button></div>
   <div id="pair-output"></div></div>
   <div class="panel spaced"><h3>Connected computers</h3><div id="device-list">Loading…</div></div>
   <div class="panel spaced"><h3>Waiting for your decision</h3>
   <p class="intro">These actions were refused automatically because they need your approval. Nothing has happened on your computer yet.</p>
   <div id="action-list">Loading…</div></div>
   <div class="panel spaced"><h3>Emergency stop</h3>
   <p id="stop-state">Checking…</p>
   <p class="intro">The emergency stop halts every paired computer and every account immediately. An operator configures <code>SAMVIT_OPERATOR_SECRET</code> to enable it.</p>
   <div class="form-row"><button class="secondary" id="stop-toggle" disabled>Loading</button></div></div>
  </section>`;

  const folderEditor = (device) => {
    const scopes = (device.scopes || []).map((scope, index) =>
      `<p><code>${esc(scope.path)}</code> · ${esc(scope.mode)} <button class="secondary" data-remove-scope="${index}" data-device="${esc(device.id)}">Remove</button></p>`).join('');
    return `<details><summary>Authorised folders (${(device.scopes || []).length})</summary>${scopes || '<p>No folders authorised yet — this computer cannot do anything.</p>'}
     <div class="form-row"><input class="search" data-scope-path="${esc(device.id)}" placeholder="C:\\Users\\you\\Projects\\Samvit" aria-label="Folder to authorise">
     <select data-scope-mode="${esc(device.id)}" aria-label="Access mode"><option value="read">Read only</option><option value="write">Read and write</option></select>
     <button class="secondary" data-add-scope="${esc(device.id)}">Authorise folder</button></div>
     <p class="intro">System folders and whole drives cannot be authorised. A symlink or junction that points outside these folders is refused by the agent.</p></details>`;
  };

  const commandEditor = (device) => `<details><summary>Approved commands (${(device.approvedCommands || []).length})</summary>
    ${(device.approvedCommands || []).map((command, index) => `<p><code>${esc(command)}</code> <button class="secondary" data-remove-command="${index}" data-device="${esc(device.id)}">Remove</button></p>`).join('') || '<p>No commands approved. Samvit can still read and write files in the folders above.</p>'}
    <div class="form-row"><input class="search" data-command-key="${esc(device.id)}" placeholder="npm run build" aria-label="Command to approve">
    <button class="secondary" data-add-command="${esc(device.id)}">Approve command</button></div>
    <p class="intro">Only these executables can ever run: node, npm, git, tsc, eslint. Shells, <code>npx</code>, <code>npm install</code> and inline evaluation are refused outright and cannot be approved.</p></details>`;

  async function refresh() {
    try {
      const data = await api('/api/devices');
      if (!alive()) return;
      const devices = data.devices || [];
      $('#device-list').innerHTML = devices.length ? devices.map(device => `<article class="record">
        <h3>${esc(device.name)} ${device.revoked ? '<span class="tag">DISCONNECTED</span>' : ''}</h3>
        <p>${esc(device.platform)} · ${esc(device.arch)} · ${device.lastSeenAt ? `last seen ${esc(new Date(device.lastSeenAt).toLocaleString())}` : 'never connected'}</p>
        ${folderEditor(device)}${commandEditor(device)}
        <div class="record-actions"><button class="secondary" data-revoke="${esc(device.id)}">${device.revoked ? 'Already disconnected' : 'Disconnect this computer'}</button></div>
      </article>`).join('') : '<p>No computers paired yet.</p>';

      const waiting = (data.actions || []).filter(action => action.status === 'pending' && action.decision?.outcome === 'ASK_USER');
      $('#action-list').innerHTML = waiting.length ? waiting.map(action => `<article class="record">
        <h3>${esc(action.capability)}</h3>
        <p>${esc(action.decision?.detail || 'This action needs your approval.')}</p>
        <p><code>${esc(JSON.stringify(action.args))}</code></p>
        <div class="record-actions">
          <button class="primary" data-approve="${esc(action.id)}">Approve once</button>
          <button class="secondary" data-deny="${esc(action.id)}">Decline</button>
        </div></article>`).join('') : '<p>Nothing is waiting for you.</p>';

      const global = data.globalStop || {halted: false};
      $('#stop-state').textContent = global.halted ? `Emergency stop is ENGAGED${global.reason ? ` — ${global.reason}` : ''}.` : 'Emergency stop is not engaged.';
      const button = $('#stop-toggle');
      if (button) { button.disabled = false; button.textContent = global.halted ? 'Release emergency stop' : 'Engage emergency stop'; }
      wire();
    } catch (error) {
      if (alive()) { $('#device-list').textContent = error.message; $('#action-list').textContent = ''; }
    }
  }

  async function policy(deviceId, change, message) {
    try {
      const data = await api('/api/devices');
      const device = (data.devices || []).find(entry => entry.id === deviceId);
      if (!device) throw Error('Computer not found');
      const next = change({scopes: [...(device.scopes || [])], approvedCommands: [...(device.approvedCommands || [])]});
      await api('/api/devices', {action: 'policy', deviceId, scopes: next.scopes, approvedCommands: next.approvedCommands});
      notify(message);
      await refresh();
    } catch (error) {
      notify(error.message);
    }
  }

  function wire() {
    main.querySelectorAll('[data-add-scope]').forEach(button => button.onclick = () => {
      const id = button.dataset.addScope;
      const path = main.querySelector(`[data-scope-path="${id}"]`)?.value?.trim();
      const mode = main.querySelector(`[data-scope-mode="${id}"]`)?.value || 'read';
      if (!path) { notify('Enter a folder path such as C:\\Users\\you\\Projects\\Samvit'); return; }
      policy(id, state => ({...state, scopes: [...state.scopes, {path, mode}]}), 'Folder authorised.');
    });
    main.querySelectorAll('[data-remove-scope]').forEach(button => button.onclick = () => {
      const index = Number(button.dataset.removeScope);
      policy(button.dataset.device, state => ({...state, scopes: state.scopes.filter((_, i) => i !== index)}), 'Folder removed.');
    });
    main.querySelectorAll('[data-add-command]').forEach(button => button.onclick = () => {
      const id = button.dataset.addCommand;
      const key = main.querySelector(`[data-command-key="${id}"]`)?.value?.trim().toLowerCase();
      if (!key) { notify('Enter a command such as npm run build'); return; }
      policy(id, state => ({...state, approvedCommands: [...new Set([...state.approvedCommands, key])]}), 'Command approved.');
    });
    main.querySelectorAll('[data-remove-command]').forEach(button => button.onclick = () => {
      const index = Number(button.dataset.removeCommand);
      policy(button.dataset.device, state => ({...state, approvedCommands: state.approvedCommands.filter((_, i) => i !== index)}), 'Command removed.');
    });
    main.querySelectorAll('[data-revoke]').forEach(button => button.onclick = async () => {
      if (!confirm('Disconnect this computer? It will stop being able to act until you pair it again.')) return;
      try {
        await api('/api/devices', {action: 'revoke', deviceId: button.dataset.revoke});
        notify('Computer disconnected.');
        await refresh();
      } catch (error) { notify(error.message); }
    });
    main.querySelectorAll('[data-approve]').forEach(button => button.onclick = async () => {
      try {
        await api('/api/devices', {action: 'approve', actionId: button.dataset.approve, approved: true});
        notify('Approved. The computer will pick it up on its next poll.');
        await refresh();
      } catch (error) { notify(error.message); }
    });
    main.querySelectorAll('[data-deny]').forEach(button => button.onclick = async () => {
      try {
        await api('/api/devices', {action: 'approve', actionId: button.dataset.deny, approved: false});
        notify('Declined. Nothing ran on your computer.');
        await refresh();
      } catch (error) { notify(error.message); }
    });
  }

  $('#pair-start').onclick = async () => {
    const button = $('#pair-start');
    button.disabled = true;
    try {
      const result = await api('/api/devices', {action: 'pair'});
      if (!alive()) return;
      $('#pair-output').innerHTML = `<p><strong>Pairing code: <code>${esc(result.code)}</code></strong></p>
        <p>On that computer, run:</p>
        <pre class="mission-output">node agent/pair.js ${esc(result.code)} --cloud ${esc(location.origin)}</pre>
        <p class="intro">${esc(result.note)}</p>`;
    } catch (error) {
      notify(error.message);
    } finally {
      if (alive()) button.disabled = false;
    }
  };

  $('#stop-toggle').onclick = async () => {
    const button = $('#stop-toggle');
    button.disabled = true;
    try {
      const current = await api('/api/devices');
      const next = !current.globalStop?.halted;
      const secret = next ? prompt('Operator secret (SAMVIT_OPERATOR_SECRET):') : prompt('Operator secret to release the stop:');
      if (secret === null) return;
      const result = await api('/api/safety', {global: true, halted: next, operatorSecret: secret, reason: next ? 'Engaged from the workspace' : null});
      notify(result.message);
      await refresh();
    } catch (error) {
      notify(error.message);
    } finally {
      if (alive()) button.disabled = false;
    }
  };

  await refresh();
}
