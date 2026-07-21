/* Publication Network manager — AdSell.ai internal tool */

const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
];

let pubs = [];
let editingId = null; // null = adding
let sortState = { key: 'state', dir: 1 }; // default: state, then city

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Toasts ---------- */
function toast(msg, isError) {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast-error' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/* ---------- API ---------- */
async function api(url, opts) {
  const resp = await fetch(url, opts);
  let data = null;
  try {
    data = await resp.json();
  } catch (e) { /* non-JSON body */ }
  if (!resp.ok) {
    const msg = (data && data.error) || 'Request failed (' + resp.status + ')';
    throw new Error(msg);
  }
  return data;
}

async function loadPubs() {
  try {
    pubs = await api('/api/publications');
    render();
  } catch (e) {
    document.getElementById('pub-count').textContent = '';
    toast('Could not load publications: ' + e.message, true);
  }
}

/* ---------- Rendering ---------- */
function currentRows() {
  const q = document.getElementById('pub-search').value.trim().toLowerCase();
  const st = document.getElementById('state-filter').value;
  let rows = pubs.filter((p) => {
    if (st && p.state !== st) return false;
    if (!q) return true;
    return (
      String(p.name).toLowerCase().includes(q) ||
      String(p.city).toLowerCase().includes(q) ||
      String(p.address || '').toLowerCase().includes(q) ||
      String(p.zip || '').includes(q)
    );
  });

  const { key, dir } = sortState;
  rows = [...rows].sort((a, b) => {
    const va = String(a[key] == null ? '' : a[key]).toLowerCase();
    const vb = String(b[key] == null ? '' : b[key]).toLowerCase();
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    // secondary: city, then name, for stable grouping
    const ca = String(a.city).toLowerCase();
    const cb = String(b.city).toLowerCase();
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
  });
  return rows;
}

function render() {
  const rows = currentRows();

  document.getElementById('pub-count').textContent =
    pubs.length + ' publication' + (pubs.length === 1 ? '' : 's') +
    (rows.length !== pubs.length ? ' (' + rows.length + ' shown)' : '');

  renderStateFilter();

  const tbody = document.getElementById('pub-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="no-pubs">No publications match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((p) => {
    const webHref = /^https?:\/\//.test(p.website || '') ? p.website : 'https://' + p.website;
    const webShown = String(p.website || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const web = p.website
      ? '<a class="web-link" href="' + esc(webHref) + '" target="_blank" rel="noopener" title="' + esc(webShown) + '">' + esc(webShown) + '</a>'
      : '<span class="no-pubs">—</span>';
    const address = p.address && p.address.trim()
      ? '<span title="' + esc(p.address) + '">' + esc(p.address) + '</span>'
      : '<span class="badge badge-muted">no address</span>';
    const coords = p.lat != null && p.lon != null
      ? '<span class="badge badge-ok" title="' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) + '">&#10003; mapped</span>'
      : '<span class="badge badge-warn">no coords</span>';
    return '<tr data-id="' + esc(p.id) + '">' +
      '<td class="market-label">' + esc(p.name) + '</td>' +
      '<td>' + esc(p.city) + '</td>' +
      '<td>' + esc(p.state) + '</td>' +
      '<td class="addr-col">' + address + '</td>' +
      '<td>' + esc(p.zip || '') + '</td>' +
      '<td class="web-col">' + web + '</td>' +
      '<td>' + coords + '</td>' +
      '<td class="actions-col">' +
        '<button class="btn btn-ghost btn-row" data-act="edit">Edit</button> ' +
        '<button class="btn btn-ghost btn-row" data-act="delete">Delete</button>' +
      '</td></tr>';
  }).join('');

  tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'edit') openModal(id);
      else deletePub(id);
    });
  });

  updateSortArrows();
}

function renderStateFilter() {
  const sel = document.getElementById('state-filter');
  const current = sel.value;
  const states = [...new Set(pubs.map((p) => p.state).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All states</option>' +
    states.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
  if (states.includes(current)) sel.value = current;
}

function updateSortArrows() {
  document.querySelectorAll('#pub-table thead th[data-key]').forEach((th) => {
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.remove();
    if (th.getAttribute('data-key') === sortState.key) {
      const s = document.createElement('span');
      s.className = 'arrow';
      s.textContent = sortState.dir === 1 ? ' \u25B2' : ' \u25BC';
      th.appendChild(s);
    }
  });
}

/* ---------- Add/Edit modal ---------- */
function openModal(id) {
  editingId = id || null;
  const pub = id ? pubs.find((p) => p.id === id) : null;
  document.getElementById('modal-title').textContent = pub ? 'Edit publication' : 'Add publication';
  document.getElementById('f-name').value = pub ? pub.name : '';
  document.getElementById('f-city').value = pub ? pub.city : '';
  document.getElementById('f-state').value = pub ? pub.state : 'AL';
  document.getElementById('f-address').value = pub ? pub.address || '' : '';
  document.getElementById('f-zip').value = pub ? pub.zip || '' : '';
  document.getElementById('f-website').value = pub ? pub.website || '' : '';
  document.getElementById('f-lat').value = pub && pub.lat != null ? pub.lat : '';
  document.getElementById('f-lon').value = pub && pub.lon != null ? pub.lon : '';
  hideModalError();
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('f-name').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  editingId = null;
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideModalError() {
  document.getElementById('modal-error').classList.add('hidden');
}

async function savePub(e) {
  e.preventDefault();
  hideModalError();

  const latRaw = document.getElementById('f-lat').value.trim();
  const lonRaw = document.getElementById('f-lon').value.trim();
  const body = {
    name: document.getElementById('f-name').value.trim(),
    city: document.getElementById('f-city').value.trim(),
    state: document.getElementById('f-state').value,
    address: document.getElementById('f-address').value.trim(),
    zip: document.getElementById('f-zip').value.trim(),
    website: document.getElementById('f-website').value.trim(),
  };
  if (body.zip && !/^\d{5}$/.test(body.zip)) {
    return showModalError('Zip must be 5 digits.');
  }
  if (latRaw !== '') {
    const lat = Number(latRaw);
    if (!Number.isFinite(lat)) return showModalError('Latitude must be a number.');
    body.lat = lat;
  }
  if (lonRaw !== '') {
    const lon = Number(lonRaw);
    if (!Number.isFinite(lon)) return showModalError('Longitude must be a number.');
    body.lon = lon;
  }
  if (!body.name || !body.city || !body.state) {
    return showModalError('Name, city, and state are required.');
  }

  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  try {
    const saved = editingId
      ? await api('/api/publications/' + encodeURIComponent(editingId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await api('/api/publications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

    const warning = saved.warning;
    delete saved.warning;
    if (editingId) {
      const i = pubs.findIndex((p) => p.id === editingId);
      if (i > -1) pubs[i] = saved;
    } else {
      pubs.push(saved);
    }
    closeModal();
    render();
    if (warning) toast('Saved, but ' + warning, true);
    else toast('Saved "' + saved.name + '"');
  } catch (err) {
    showModalError(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Delete ---------- */
async function deletePub(id) {
  const pub = pubs.find((p) => p.id === id);
  if (!pub) return;
  if (!window.confirm('Delete "' + pub.name + '" (' + pub.city + ', ' + pub.state + ')?')) return;
  try {
    await api('/api/publications/' + encodeURIComponent(id), { method: 'DELETE' });
    pubs = pubs.filter((p) => p.id !== id);
    render();
    toast('Deleted "' + pub.name + '"');
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

/* ---------- Import / Export ---------- */
function exportJson() {
  // navigation request so the browser handles the download (and any auth prompt)
  window.location.href = '/api/publications/export';
}

async function importJson(file) {
  let rows;
  try {
    rows = JSON.parse(await file.text());
  } catch (e) {
    return toast('Import failed: file is not valid JSON.', true);
  }
  if (!Array.isArray(rows)) {
    return toast('Import failed: JSON must be an array of publications.', true);
  }
  if (!window.confirm(
    'Import ' + rows.length + ' publications?\n\nThis REPLACES the entire current list (' +
    pubs.length + ' publications). A one-deep backup is kept on the server.'
  )) return;

  try {
    const result = await api('/api/publications/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    });
    toast('Imported ' + result.count + ' publications.');
    await loadPubs();
  } catch (e) {
    toast('Import failed: ' + e.message, true);
  }
}

/* ---------- Init ---------- */
function init() {
  const stateSel = document.getElementById('f-state');
  stateSel.innerHTML = STATE_CODES
    .map((s) => '<option value="' + s + '">' + s + '</option>')
    .join('');

  document.getElementById('add-btn').addEventListener('click', () => openModal(null));
  document.getElementById('export-btn').addEventListener('click', exportJson);
  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = ''; // allow re-selecting the same file
  });

  document.getElementById('pub-form').addEventListener('submit', savePub);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('pub-search').addEventListener('input', render);
  document.getElementById('state-filter').addEventListener('change', render);

  document.querySelectorAll('#pub-table thead th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      if (sortState.key === key) sortState.dir *= -1;
      else sortState = { key, dir: 1 };
      render();
    });
  });

  loadPubs();
}

document.addEventListener('DOMContentLoaded', init);
