'use strict';

const main = document.querySelector('#main');
const account = document.querySelector('#account');
const notice = document.querySelector('#notice');
let user;
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const displayName = actor => actor === 'alice' ? 'Alice' : 'Bob';

function message(text, error = false) {
  notice.hidden = false;
  notice.className = error ? 'notice error' : 'notice success';
  notice.textContent = text;
}

async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const error = new Error(`${response.status} · ${body.error.message}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function perform(action, button) {
  if (button) button.disabled = true;
  try { await action(); } catch (error) { message(error.message, true); }
  finally { if (button) button.disabled = false; }
}

function renderAccount() {
  account.innerHTML = user ? `<span class="avatar">${escape(user.displayName[0])}</span><span>${escape(user.displayName)}</span><button class="quiet" id="logout">Sign out</button>` : '<span class="pill">PRIVATE BY DESIGN</span>';
  document.querySelector('#logout')?.addEventListener('click', event => perform(async () => {
    await api('/api/session', 'DELETE'); user = undefined; location.hash = ''; renderLogin();
    notice.hidden = true;
  }, event.currentTarget));
}

function renderLogin() {
  renderAccount();
  main.innerHTML = `<section class="login-layout"><div class="intro"><p class="eyebrow">ROOM FOR YOUR NEXT IDEA</p><h1>Good work starts<br>on the same page.</h1><p class="lede">A shared place for your team's notes, plans, and the things you're figuring out together.</p><div class="paper-preview" aria-hidden="true"><span class="paper-tag">THE SHARED NOTEBOOK</span><div class="paper-line long"></div><div class="paper-line"></div><div class="paper-line short"></div><span class="paper-annotation">Make something good. ↗</span></div></div><section class="login-card"><span class="step-label">01 / WELCOME BACK</span><h2>Find your space.</h2><p>Sign in with your local fixture account.</p><form id="login"><label for="actor">Account</label><select id="actor" name="actorKey"><option value="alice">Alice</option><option value="bob">Bob</option></select><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button class="primary full" type="submit">Sign in <span aria-hidden="true">↗</span></button></form><p class="form-note">Local test accounts only. Credentials are shown by the demo launcher.</p></section></section>`;
  document.querySelector('#login').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    perform(async () => {
      user = await api('/api/session', 'POST', Object.fromEntries(values));
      form.reset(); notice.hidden = true; await renderRoute();
    }, form.querySelector('button'));
  });
}

async function renderHome() {
  const [workspaces, invitations] = await Promise.all([api('/api/workspaces'), api('/api/invitations')]);
  main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">YOUR SHARED SPACES</p><h1>A place for the work.</h1><p class="lede">Welcome back, ${escape(user.displayName)}. Pick up where your team left off.</p></div><button class="secondary" id="refresh">Refresh</button></div><div class="home-grid"><section><div class="section-heading"><h2>Workspaces</h2><span class="count">${workspaces.length}</span></div><div class="workspace-list">${workspaces.length ? workspaces.map(ws => `<a class="workspace-card" href="#workspace/${escape(ws.id)}"><span class="workspace-icon" aria-hidden="true">▤</span><span><strong>${escape(ws.name)}</strong><small>Open workspace</small></span><span class="card-arrow" aria-hidden="true">↗</span></a>`).join('') : '<div class="empty-state"><span aria-hidden="true">▤</span><h3>A fresh page.</h3><p>Create a workspace or accept an invitation to get started.</p></div>'}</div><div class="section-heading invitations-heading"><h2>Invitations</h2><span class="count">${invitations.length}</span></div><div>${invitations.length ? invitations.map(inv => `<article class="invitation"><div><strong>${escape(inv.workspaceName)}</strong><p>You're invited to join as a member.</p></div><button class="secondary accept" data-id="${escape(inv.id)}">Accept invitation</button></article>`).join('') : '<p class="muted">No pending invitations. You’re all caught up.</p>'}</div></section><section class="create-card"><span class="step-label">A NEW CHAPTER</span><h2>Make room.</h2><p>Start a workspace and invite someone to build alongside you.</p><form id="create-workspace"><label for="workspace-name">Workspace name</label><input id="workspace-name" name="name" placeholder="e.g. Studio notes" required maxlength="120"><button class="primary full" type="submit">Create workspace <span aria-hidden="true">+</span></button></form></section></div>`;
  document.querySelector('#refresh').addEventListener('click', event => perform(renderHome, event.currentTarget));
  document.querySelector('#create-workspace').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    perform(async () => {
      const result = await api('/api/workspaces', 'POST', Object.fromEntries(new FormData(form)));
      location.hash = `workspace/${result.workspace.id}`;
      message('Workspace created. Your first shared document is ready.');
    }, form.querySelector('button'));
  });
  document.querySelectorAll('.accept').forEach(button => button.addEventListener('click', () => perform(async () => {
    await api(`/api/invitations/${button.dataset.id}/accept`, 'POST', {});
    await renderHome(); message('Invitation accepted. You’re part of the workspace.');
  }, button)));
}

async function renderWorkspace(id) {
  const workspace = await api(`/api/workspaces/${encodeURIComponent(id)}`);
  main.innerHTML = `<a class="breadcrumb" href="#">← All workspaces</a><div class="page-heading"><div><p class="eyebrow">SHARED WORKSPACE</p><h1>${escape(workspace.name)}</h1><p class="lede">A home for your team's work in progress.</p></div><span class="pill">${workspace.role === 'admin' ? 'ADMINISTRATOR' : 'MEMBER'}</span></div><div class="workspace-grid"><section><div class="section-heading"><h2>Documents</h2><span class="count">${workspace.documents.length}</span></div>${workspace.documents.map(doc => `<a class="document-card" href="#document/${escape(doc.id)}"><div class="document-icon" aria-hidden="true">≡</div><span class="step-label">TEAM NOTEBOOK</span><h2>Shared document</h2><p>Ideas, plans, and a little room to think.</p><span class="document-link">Open document <span aria-hidden="true">↗</span></span></a>`).join('')}</section><section class="members-panel"><div class="section-heading"><h2>People</h2><button class="quiet" id="refresh-members">Refresh members</button></div><div>${workspace.members.map(member => `<div class="member"><span class="avatar ${member.actorKey === 'bob' ? 'sand' : ''}">${escape(displayName(member.actorKey)[0])}</span><div><strong>${displayName(member.actorKey)}</strong><small>${member.role === 'admin' ? 'Administrator' : 'Member'}</small></div>${workspace.role === 'admin' && member.actorKey !== user.actorKey ? `<button class="remove quiet" data-actor="${member.actorKey}" aria-label="Remove ${displayName(member.actorKey)}">Remove</button>` : ''}</div>`).join('')}</div>${workspace.role === 'admin' ? `<form id="invite" class="invite-form"><label for="recipient">Invite a teammate</label><select id="recipient" name="recipient"><option value="${user.actorKey === 'alice' ? 'bob' : 'alice'}">${user.actorKey === 'alice' ? 'Bob' : 'Alice'}</option></select><button class="secondary full" type="submit">Send invitation <span aria-hidden="true">↗</span></button></form>` : '<p class="form-note">Your administrator manages workspace membership.</p>'}</section></div>`;
  document.querySelector('#refresh-members').addEventListener('click', event => perform(() => renderWorkspace(id), event.currentTarget));
  document.querySelector('#invite')?.addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    perform(async () => {
      await api(`/api/workspaces/${encodeURIComponent(id)}/invitations`, 'POST', Object.fromEntries(new FormData(form)));
      message('Invitation sent. Your teammate can accept it from Workspaces.');
    }, form.querySelector('button'));
  });
  document.querySelectorAll('.remove').forEach(button => button.addEventListener('click', () => perform(async () => {
    await api(`/api/workspaces/${encodeURIComponent(id)}/members/${button.dataset.actor}`, 'DELETE');
    await renderWorkspace(id); message(`${displayName(button.dataset.actor)} removed from the workspace.`);
  }, button)));
}

async function renderDocument(id) {
  const doc = await api(`/api/documents/${encodeURIComponent(id)}`);
  main.innerHTML = `<a class="breadcrumb" href="#workspace/${escape(doc.workspaceId)}">← Back to workspace</a><div class="page-heading"><div><p class="eyebrow">TEAM NOTEBOOK</p><h1>Shared document</h1><p class="lede">Keep your team's thinking in one place.</p></div><span class="pill" id="revision">REVISION ${doc.revision}</span></div><form id="edit-document" class="editor"><div class="editor-toolbar"><label for="document-body">Document body</label><span>PLAIN TEXT</span></div><textarea id="document-body" name="body" maxlength="10000" spellcheck="false">${escape(doc.body)}</textarea><div class="editor-bottom"><span class="muted">Editing as ${escape(user.displayName)}</span><button class="primary" type="submit">Save document <span aria-hidden="true">↗</span></button></div></form><p class="editor-note">Changes are shared with everyone in this workspace.</p>`;
  document.querySelector('#edit-document').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    perform(async () => {
      const updated = await api(`/api/documents/${encodeURIComponent(id)}`, 'PATCH', { body: new FormData(form).get('body'), expectedRevision: doc.revision });
      doc.revision = updated.revision;
      document.querySelector('#revision').textContent = `REVISION ${doc.revision}`;
      message(`200 · Document saved. Revision ${doc.revision}.`);
    }, form.querySelector('button'));
  });
}

async function renderRoute() {
  if (!user) { renderLogin(); return; }
  renderAccount();
  const [kind, id] = location.hash.slice(1).split('/');
  // Never keep a previous actor's or route's document on screen after a failed navigation.
  main.innerHTML = '<p class="muted">Opening your space…</p>';
  try {
    if (kind === 'workspace' && id) await renderWorkspace(id);
    else if (kind === 'document' && id) await renderDocument(id);
    else await renderHome();
  } catch (error) {
    if (error.status === 401) { user = undefined; renderLogin(); }
    else main.innerHTML = '<div class="empty-state"><h1>This space is unavailable.</h1><p>Your current session may no longer have access.</p><a class="secondary" href="#">Back to workspaces</a></div>';
    message(error.message, true);
  }
}

window.addEventListener('hashchange', () => { notice.hidden = true; void renderRoute(); });
void (async () => {
  try { user = await api('/api/session'); } catch (error) { if (error.status !== 401) message(error.message, true); }
  await renderRoute();
})();
