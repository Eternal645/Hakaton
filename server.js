'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('node:path');
const fs      = require('node:fs/promises');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB   = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


async function readDB() {
  try {
    return JSON.parse(await fs.readFile(DB, 'utf8'));
  } catch {
    const init = { users: [], organizations: [], shifts: [], notifications: [] };
    await writeDB(init);
    return init;
  }
}

let queue = Promise.resolve();
function writeDB(db) {
  queue = queue.then(async () => {
    const tmp = DB + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, DB);
  });
  return queue;
}

function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

function pub(u) {
  if (!u) return null;
  const { password, ...r } = u;
  const p = (r.name || '').trim().split(' ');
  r.initials = p.length >= 2
    ? (p[0][0] + p[1][0]).toUpperCase()
    : (r.name || '??').slice(0, 2).toUpperCase();
  return r;
}


async function auth(req, res, next) {
  const id = Number(req.headers['x-user-id']);
  if (!id) return res.status(401).json({ ok: false, error: 'Нет авторизации' });
  const db   = await readDB();
  const user = db.users.find(u => u.id === id && u.active);
  if (!user) return res.status(401).json({ ok: false, error: 'Не найден' });
  req.user = pub(user);
  next();
}


async function notify(db, { userId, type, title, message }) {
  if (!db.notifications) db.notifications = [];
  db.notifications.push({
    id: nextId(db.notifications),
    userId: Number(userId),
    type, title, message,
    read: false,
    createdAt: new Date().toISOString()
  });
  await writeDB(db);
}


app.get('/api/health', (_, res) => res.json({ ok: true }));


app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    const db   = await readDB();
    const user = db.users.find(u => u.login === String(login || '').toLowerCase().trim());
    if (!user)                        return res.status(401).json({ ok: false, error: 'Пользователь не найден' });
    if (!user.active)                 return res.status(403).json({ ok: false, error: 'Аккаунт заблокирован' });
    if (user.password !== String(password)) return res.status(401).json({ ok: false, error: 'Неверный пароль' });
    res.json({ ok: true, user: pub(user) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.post('/api/auth/logout', (_, res) => res.json({ ok: true }));


app.get('/api/users', auth, async (req, res) => {
  try {
    const db = await readDB();
    let list = db.users.map(pub);
    if (req.user.role === 'employee') list = list.filter(u => u.id === req.user.id);
    if (req.user.role === 'manager')  list = list.filter(u => u.dept === req.user.dept || u.id === req.user.id);
    if (req.query.dept)  list = list.filter(u => u.dept  === req.query.dept);
    if (req.query.orgId) list = list.filter(u => u.orgId === Number(req.query.orgId));
    if (req.query.role)  list = list.filter(u => u.role  === req.query.role);
    res.json({ ok: true, users: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/users/:id', auth, async (req, res) => {
  try {
    const db   = await readDB();
    const user = db.users.find(u => u.id === Number(req.params.id));
    if (!user) return res.status(404).json({ ok: false, error: 'Не найден' });
    res.json({ ok: true, user: pub(user) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });

    const db    = await readDB();
    const data  = req.body || {};
    const login = String(data.login || '').toLowerCase().trim();

    const errors = [];
    if (!data.name)     errors.push('Укажите имя');
    if (!login)         errors.push('Укажите логин');
    if (!data.password) errors.push('Укажите пароль');
    if (data.password && data.password.length < 6) errors.push('Пароль минимум 6 символов');
    if (db.users.some(u => u.login === login)) errors.push('Логин уже занят');
    if (errors.length) return res.status(400).json({ ok: false, error: errors.join('. ') });

    const role = (req.user.role === 'manager' && data.role === 'admin') ? 'employee' : (data.role || 'employee');

    const newUser = {
      id:        nextId(db.users),
      login,
      password:  String(data.password),
      role,
      name:      String(data.name).trim(),
      dept:      data.dept  || null,
      orgId:     data.orgId ? Number(data.orgId) : null,
      active:    true,
      createdAt: new Date().toISOString()
    };

    db.users.push(newUser);
    await writeDB(db);
    await notify(db, {
      userId:  newUser.id,
      type:    'welcome',
      title:   'Добро пожаловать в T2.beta!',
      message: 'Ваш аккаунт создан. Войдите и заполните график.'
    });

    res.status(201).json({ ok: true, user: pub(newUser) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/users/:id', auth, async (req, res) => {
  try {
    const db  = await readDB();
    const id  = Number(req.params.id);
    if (req.user.id !== id && !['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найден' });
    const { password, id: _id, createdAt, ...fields } = req.body || {};
    db.users[idx] = { ...db.users[idx], ...fields, id, updatedAt: new Date().toISOString() };
    await writeDB(db);
    res.json({ ok: true, user: pub(db.users[idx]) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/users/:id/toggle', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db  = await readDB();
    const id  = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Нельзя заблокировать себя' });
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найден' });
    db.users[idx].active = !db.users[idx].active;
    await writeDB(db);
    res.json({ ok: true, active: db.users[idx].active });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db = await readDB();
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Нельзя удалить себя' });
    db.users  = db.users.filter(u => u.id !== id);
    db.shifts = db.shifts.filter(s => s.userId !== id);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/users/:id/password', auth, async (req, res) => {
  try {
    const db  = await readDB();
    const id  = Number(req.params.id);
    if (req.user.id !== id && req.user.role !== 'admin')
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    const { oldPassword, newPassword } = req.body || {};
    const idx = db.users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найден' });
    if (req.user.id === id && db.users[idx].password !== oldPassword)
      return res.status(401).json({ ok: false, error: 'Неверный текущий пароль' });
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ ok: false, error: 'Пароль минимум 6 символов' });
    db.users[idx].password = newPassword;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


function getSubtreeIds(orgs, rootId) {
  const result = [rootId];
  orgs.filter(o => o.parentId === rootId).forEach(c => result.push(...getSubtreeIds(orgs, c.id)));
  return result;
}

app.get('/api/orgs', auth, async (req, res) => {
  try {
    const db = await readDB();
    res.json({ ok: true, orgs: db.organizations });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/orgs/tree', auth, async (req, res) => {
  try {
    const db   = await readDB();
    const orgs = db.organizations;
    function buildTree(parentId = null) {
      return orgs.filter(o => o.parentId === parentId).map(o => ({
        ...o,
        empCount: db.users.filter(u => u.dept === o.name).length,
        children: buildTree(o.id)
      }));
    }
    res.json({ ok: true, tree: buildTree(null) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/orgs', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db   = await readDB();
    const data = req.body || {};
    if (!data.name) return res.status(400).json({ ok: false, error: 'Укажите название' });
    const newOrg = {
      id:        nextId(db.organizations),
      name:      String(data.name).trim(),
      type:      data.type      || 'dept',
      parentId:  data.parentId  || null,
      managerId: data.managerId || null,
      createdAt: new Date().toISOString()
    };
    db.organizations.push(newOrg);
    await writeDB(db);
    res.status(201).json({ ok: true, org: newOrg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put('/api/orgs/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db  = await readDB();
    const id  = Number(req.params.id);
    const idx = db.organizations.findIndex(o => o.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });
    if (req.body.parentId) {
      const sub = getSubtreeIds(db.organizations, id);
      if (sub.includes(req.body.parentId))
        return res.status(400).json({ ok: false, error: 'Зацикливание дерева' });
    }
    const { id: _id, createdAt, ...fields } = req.body || {};
    db.organizations[idx] = { ...db.organizations[idx], ...fields, id };
    await writeDB(db);
    res.json({ ok: true, org: db.organizations[idx] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/orgs/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db       = await readDB();
    const toDelete = getSubtreeIds(db.organizations, Number(req.params.id));
    db.organizations = db.organizations.filter(o => !toDelete.includes(o.id));
    await writeDB(db);
    res.json({ ok: true, deletedCount: toDelete.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.get('/api/shifts', auth, async (req, res) => {
  try {
    const db = await readDB();
    let list = [...db.shifts];
    if (req.user.role === 'employee') list = list.filter(s => s.userId === req.user.id);
    if (req.user.role === 'manager') {
      const ids = db.users.filter(u => u.dept === req.user.dept).map(u => u.id);
      list = list.filter(s => ids.includes(s.userId));
    }
    if (req.query.userId) list = list.filter(s => s.userId === Number(req.query.userId));
    if (req.query.from)   list = list.filter(s => s.date >= req.query.from);
    if (req.query.to)     list = list.filter(s => s.date <= req.query.to);
    if (req.query.status) list = list.filter(s => s.status === req.query.status);
    if (req.query.dept) {
      const ids = db.users.filter(u => u.dept === req.query.dept).map(u => u.id);
      list = list.filter(s => ids.includes(s.userId));
    }
    list = list.map(s => {
      const u = db.users.find(x => x.id === s.userId);
      return { ...s, userName: u ? u.name : '—', userDept: u ? u.dept : '—' };
    });
    list.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ ok: true, shifts: list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/shifts', auth, async (req, res) => {
  try {
    const db     = await readDB();
    const data   = req.body || {};
    const userId = Number(data.userId) || req.user.id;
    if (req.user.role === 'employee' && userId !== req.user.id)
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    if (!data.date)
      return res.status(400).json({ ok: false, error: 'Укажите дату' });
    const idx = db.shifts.findIndex(s => s.userId === userId && s.date === data.date);
    const entry = {
      id:          idx >= 0 ? db.shifts[idx].id : nextId(db.shifts),
      userId,
      date:        data.date,
      type:        data.type    || 'standard',
      start:       data.start   || null,
      end:         data.end     || null,
      status:      idx >= 0 ? db.shifts[idx].status : 'planned',
      factStart:   data.factStart   || (idx >= 0 ? db.shifts[idx].factStart   : null),
      factEnd:     data.factEnd     || (idx >= 0 ? db.shifts[idx].factEnd     : null),
      comment:     data.comment     ?? (idx >= 0 ? db.shifts[idx].comment     : ''),
      confirmedBy: idx >= 0 ? db.shifts[idx].confirmedBy : null,
      confirmedAt: idx >= 0 ? db.shifts[idx].confirmedAt : null,
      updatedAt:   new Date().toISOString()
    };
    if (idx >= 0) db.shifts[idx] = entry;
    else          db.shifts.push(entry);
    await writeDB(db);
    res.status(idx >= 0 ? 200 : 201).json({ ok: true, shift: entry });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/shifts/:id', auth, async (req, res) => {
  try {
    const db  = await readDB();
    const id  = Number(req.params.id);
    const idx = db.shifts.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const shift = db.shifts[idx];
    if (req.user.role === 'employee') {
      if (shift.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'Чужая смена' });
      if (shift.status === 'confirmed') return res.status(400).json({ ok: false, error: 'Нельзя удалить подтверждённую смену' });
    }
    db.shifts.splice(idx, 1);
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/shifts/:id/confirm', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Только руководитель' });
    const db  = await readDB();
    const id  = Number(req.params.id);
    const idx = db.shifts.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });
    db.shifts[idx].status      = 'confirmed';
    db.shifts[idx].confirmedBy = req.user.id;
    db.shifts[idx].confirmedAt = new Date().toISOString();
    await writeDB(db);
    await notify(db, {
      userId:  db.shifts[idx].userId,
      type:    'confirmed',
      title:   'Смена подтверждена',
      message: `Смена ${db.shifts[idx].date} подтверждена руководителем`
    });
    res.json({ ok: true, shift: db.shifts[idx] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/shifts/:id/reject', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Только руководитель' });
    const db  = await readDB();
    const id  = Number(req.params.id);
    const idx = db.shifts.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });
    db.shifts[idx].status        = 'rejected';
    db.shifts[idx].rejectComment = req.body?.comment || '';
    await writeDB(db);
    await notify(db, {
      userId:  db.shifts[idx].userId,
      type:    'rejected',
      title:   'Смена отклонена',
      message: `Смена ${db.shifts[idx].date} возвращена на доработку. ${req.body?.comment || ''}`
    });
    res.json({ ok: true, shift: db.shifts[idx] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/shifts/:id/fact', auth, async (req, res) => {
  try {
    const db  = await readDB();
    const id  = Number(req.params.id);
    const idx = db.shifts.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const { factStart, factEnd } = req.body || {};
    if (!factStart || !factEnd) return res.status(400).json({ ok: false, error: 'factStart и factEnd обязательны' });
    db.shifts[idx].factStart = factStart;
    db.shifts[idx].factEnd   = factEnd;
    db.shifts[idx].updatedAt = new Date().toISOString();
    await writeDB(db);
    res.json({ ok: true, shift: db.shifts[idx] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


function calcMins(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let d = (eh * 60 + em) - (sh * 60 + sm);
  if (d < 0) d += 1440;
  return d;
}

app.get('/api/planfact', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    const db = await readDB();
    let shifts = [...db.shifts];
    if (req.query.from) shifts = shifts.filter(s => s.date >= req.query.from);
    if (req.query.to)   shifts = shifts.filter(s => s.date <= req.query.to);
    if (req.query.dept) {
      const ids = db.users.filter(u => u.dept === req.query.dept).map(u => u.id);
      shifts = shifts.filter(s => ids.includes(s.userId));
    }
    const rows = shifts.map(s => {
      const u   = db.users.find(x => x.id === s.userId);
      const pm  = calcMins(s.start, s.end);
      const fm  = calcMins(s.factStart, s.factEnd);
      return {
        shiftId:     s.id,
        date:        s.date,
        userId:      s.userId,
        userName:    u ? u.name : '—',
        userDept:    u ? u.dept : '—',
        planStart:   s.start,
        planEnd:     s.end,
        planHours:   +(pm / 60).toFixed(2),
        factStart:   s.factStart,
        factEnd:     s.factEnd,
        factHours:   +(fm / 60).toFixed(2),
        diffMins:    fm - pm,
        diffHours:   +((fm - pm) / 60).toFixed(2),
        status:      s.status
      };
    });
    const summary = {
      total:           rows.length,
      matched:         rows.filter(r => Math.abs(r.diffMins) <= 15).length,
      deviated:        rows.filter(r => Math.abs(r.diffMins) > 15).length,
      critical:        rows.filter(r => !r.factStart).length,
      totalPlanHours:  +rows.reduce((s, r) => s + r.planHours, 0).toFixed(2),
      totalFactHours:  +rows.reduce((s, r) => s + r.factHours, 0).toFixed(2)
    };
    res.json({ ok: true, rows, summary });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.get('/api/stats', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    const db   = await readDB();
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to   = req.query.to   || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    let users  = db.users.filter(u => u.role === 'employee' && u.active);
    if (req.user.role === 'manager') users = users.filter(u => u.dept === req.user.dept);
    const ids    = users.map(u => u.id);
    const shifts = db.shifts.filter(s => ids.includes(s.userId) && s.date >= from && s.date <= to);
    const filled = [...new Set(shifts.map(s => s.userId))];
    res.json({
      ok: true,
      stats: {
        totalEmployees:    users.length,
        filledSchedule:    filled.length,
        notFilledSchedule: users.length - filled.length,
        confirmedShifts:   shifts.filter(s => s.status === 'confirmed').length,
        pendingShifts:     shifts.filter(s => s.status === 'planned').length,
        rejectedShifts:    shifts.filter(s => s.status === 'rejected').length
      }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.get('/api/notifications', auth, async (req, res) => {
  try {
    const db   = await readDB();
    const list = (db.notifications || [])
      .filter(n => n.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ ok: true, notifications: list, unread: list.filter(n => !n.read).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.patch('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    const db  = await readDB();
    const idx = (db.notifications || []).findIndex(n => n.id === Number(req.params.id) && n.userId === req.user.id);
    if (idx === -1) return res.status(404).json({ ok: false });
    db.notifications[idx].read = true;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    const db = await readDB();
    (db.notifications || []).forEach(n => { if (n.userId === req.user.id) n.read = true; });
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  try {
    const db = await readDB();
    db.notifications = (db.notifications || []).filter(
      n => !(n.id === Number(req.params.id) && n.userId === req.user.id)
    );
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


app.get('/api/export/csv', auth, async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
    const db = await readDB();
    let shifts = [...db.shifts];
    if (req.query.from)   shifts = shifts.filter(s => s.date >= req.query.from);
    if (req.query.to)     shifts = shifts.filter(s => s.date <= req.query.to);
    if (req.query.userId) shifts = shifts.filter(s => s.userId === Number(req.query.userId));
    if (req.query.dept) {
      const ids = db.users.filter(u => u.dept === req.query.dept).map(u => u.id);
      shifts = shifts.filter(s => ids.includes(s.userId));
    }
    shifts.sort((a, b) => a.date.localeCompare(b.date));

    const statusLabel = { planned: 'Запланировано', confirmed: 'Подтверждено', rejected: 'Отклонено' };
    const typeLabel   = { standard: 'Стандарт', evening: 'Вечер', night: 'Ночь', off: 'Выходной', vacation: 'Отпуск', sick: 'Больничный' };

    function esc(v) {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }
    function hrs(a, b) {
      if (!a || !b) return '';
      const m = calcMins(a, b);
      return (m / 60).toFixed(2);
    }

    const headers = ['Дата','Сотрудник','Подразделение','Тип','Начало (план)','Конец (план)','Начало (факт)','Конец (факт)','Часы (план)','Часы (факт)','Статус','Комментарий'];
    const rows = shifts.map(s => {
      const u = db.users.find(x => x.id === s.userId);
      return [
        s.date, u ? u.name : s.userId, u ? (u.dept || '') : '',
        typeLabel[s.type] || s.type,
        s.start || '', s.end || '', s.factStart || '', s.factEnd || '',
        hrs(s.start, s.end), hrs(s.factStart, s.factEnd),
        statusLabel[s.status] || s.status, s.comment || ''
      ].map(esc).join(',');
    });

    const csv  = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const name = `shifts_${req.query.from || 'all'}_${req.query.to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/export/json', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Только администратор' });
    const db = await readDB();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="t2beta_db.json"');
    res.send(JSON.stringify({ ...db, users: db.users.map(pub) }, null, 2));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.use('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: `${req.method} ${req.path} не найден` });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ██████████╗ ██████╗     ██████╗ ███████╗████████╗ █████╗');
  console.log('  ╚══██╔══╝ ╚════██╗    ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗');
  console.log('     ██║    █████╔╝    ██████╔╝█████╗     ██║   ███████║');
  console.log('     ██║    ╚═══██╗    ██╔══██╗██╔══╝     ██║   ██╔══██║');
  console.log('     ██║   ██████╔╝    ██████╔╝███████╗   ██║   ██║  ██║');
  console.log('');
  console.log(`  ✅  Сервер запущен: http://localhost:${PORT}`);
  console.log(`  📁  База данных:    ${DB}`);
  console.log('');
});