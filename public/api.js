const SESSION_KEY = 't2beta_user';

function getSession()      { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } }
function setSession(user)  { sessionStorage.setItem(SESSION_KEY, JSON.stringify(user)); }
function clearSession()    { sessionStorage.removeItem(SESSION_KEY); }

async function api(endpoint, { method = 'GET', body, download = false } = {}) {
  const s       = getSession();
  const headers = {};
  if (body)    headers['Content-Type'] = 'application/json';
  if (s?.id)   headers['X-User-Id']    = s.id;
  const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (download) { if (!res.ok) throw new Error('Ошибка скачивания'); return res.blob(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function dlFile(endpoint, filename) {
  const blob = await api(endpoint, { download: true });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function qs(obj) {
  const p = new URLSearchParams(obj);
  return p.toString() ? '?' + p.toString() : '';
}

async function apiLogin(login, password) {
  const r = await api('/api/auth/login', { method: 'POST', body: { login, password } });
  setSession(r.user);
  return r.user;
}
async function apiLogout()  { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); clearSession(); }
async function apiGetMe()   { return (await api('/api/auth/me')).user; }

async function apiGetUsers(f = {})        { return (await api('/api/users' + qs(f))).users; }
async function apiGetUser(id)             { return (await api(`/api/users/${id}`)).user; }
async function apiCreateUser(data)        { return (await api('/api/users', { method: 'POST', body: data })).user; }
async function apiUpdateUser(id, data)    { return (await api(`/api/users/${id}`, { method: 'PUT', body: data })).user; }
async function apiToggleUser(id)          { return (await api(`/api/users/${id}/toggle`, { method: 'PATCH' })).active; }
async function apiDeleteUser(id)          { return api(`/api/users/${id}`, { method: 'DELETE' }); }
async function apiChangePassword(id, o, n){ return api(`/api/users/${id}/password`, { method: 'PUT', body: { oldPassword: o, newPassword: n } }); }

async function apiGetOrgs()               { return (await api('/api/orgs')).orgs; }
async function apiGetOrgTree()            { return (await api('/api/orgs/tree')).tree; }
async function apiCreateOrg(data)         { return (await api('/api/orgs', { method: 'POST', body: data })).org; }
async function apiUpdateOrg(id, data)     { return (await api(`/api/orgs/${id}`, { method: 'PUT', body: data })).org; }
async function apiDeleteOrg(id)           { return api(`/api/orgs/${id}`, { method: 'DELETE' }); }

async function apiGetShifts(f = {})       { return (await api('/api/shifts' + qs(f))).shifts; }
async function apiUpsertShift(data)       { return (await api('/api/shifts', { method: 'POST', body: data })).shift; }
async function apiDeleteShift(id)         { return api(`/api/shifts/${id}`, { method: 'DELETE' }); }
async function apiConfirmShift(id)        { return (await api(`/api/shifts/${id}/confirm`, { method: 'POST' })).shift; }
async function apiRejectShift(id, comment){ return (await api(`/api/shifts/${id}/reject`,  { method: 'POST', body: { comment } })).shift; }
async function apiSetFact(id, fs, fe)     { return (await api(`/api/shifts/${id}/fact`,    { method: 'POST', body: { factStart: fs, factEnd: fe } })).shift; }

async function apiGetPlanFact(f = {})     { return api('/api/planfact' + qs(f)); }
async function apiGetStats(f = {})        { return (await api('/api/stats' + qs(f))).stats; }

async function apiGetNotifications()      { return api('/api/notifications'); }
async function apiReadNotif(id)           { return api(`/api/notifications/${id}/read`, { method: 'PATCH' }); }
async function apiReadAllNotifs()         { return api('/api/notifications/read-all',   { method: 'POST' }); }
async function apiDeleteNotif(id)         { return api(`/api/notifications/${id}`,      { method: 'DELETE' }); }

async function apiExportCSV(f = {})  { await dlFile('/api/export/csv'  + qs(f), `shifts_${f.from||'all'}_${f.to||'all'}.csv`); }
async function apiExportJSON()       { await dlFile('/api/export/json',           't2beta_db.json'); }