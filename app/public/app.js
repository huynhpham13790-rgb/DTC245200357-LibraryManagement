// ===== Tiện ích chung =====
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d).toLocaleDateString('vi-VN') : '';
const fmtMoney = n => Number(n || 0).toLocaleString('vi-VN') + 'đ';
const modal = id => bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
let currentUser = null;

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${type} border-0`;
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $('#toasts').appendChild(el);
  new bootstrap.Toast(el, { delay: 3500 }).show();
  el.addEventListener('hidden.bs.toast', () => el.remove());
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.message) toast(e.message, 'danger'); } };

function confirmBox(text) {
  return new Promise(resolve => {
    $('#confirmText').textContent = text;
    const ok = $('#confirmOk');
    const m = modal('confirmModal');
    const done = v => { ok.onclick = null; m.hide(); resolve(v); };
    ok.onclick = () => done(true);
    document.getElementById('confirmModal').addEventListener('hidden.bs.modal', () => resolve(false), { once: true });
    m.show();
  });
}
const formData = form => Object.fromEntries(new FormData(form).entries());
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ===== Đăng nhập / điều hướng =====
function showLogin() {
  $('#appView').classList.add('d-none');
  $('#loginView').classList.remove('d-none');
}
function showApp(user) {
  currentUser = user;
  $('#userName').textContent = user.full_name;
  $('#userRole').textContent = (user.role === 'admin' ? 'Quản trị viên' : 'Thủ thư') + ' · ' + user.username;
  document.querySelectorAll('.admin-only').forEach(e => e.classList.toggle('d-none', user.role !== 'admin'));
  $('#loginView').classList.add('d-none');
  $('#appView').classList.remove('d-none');
  go(location.hash.slice(1) || 'dashboard');
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#loginError');
  err.classList.add('d-none');
  try {
    const { user } = await api('/api/login', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    showApp(user);
  } catch (ex) { err.textContent = ex.message; err.classList.remove('d-none'); }
});
$('#btnLogout').onclick = run(async e => { e.preventDefault(); await api('/api/logout', { method: 'POST' }); showLogin(); });
$('#btnChangePw').onclick = e => { e.preventDefault(); $('#pwForm').reset(); modal('pwModal').show(); };
$('#pwForm').onsubmit = run(async e => {
  e.preventDefault();
  await api('/api/me/password', { method: 'POST', body: formData(e.target) });
  modal('pwModal').hide(); toast('Đã đổi mật khẩu');
});

const PAGES = {
  dashboard: ['Tổng quan', loadDashboard],
  books: ['Kho sách', loadBooks],
  readers: ['Quản lý độc giả', loadReaders],
  circulation: ['Mượn / Trả sách', loadCirculation],
  overdue: ['Sách quá hạn', loadOverdue],
  users: ['Tài khoản thủ thư', loadUsers]
};
function go(page) {
  if (!PAGES[page]) page = 'dashboard';
  location.hash = page;
  document.querySelectorAll('.page').forEach(p => p.classList.add('d-none'));
  $('#page-' + page).classList.remove('d-none');
  document.querySelectorAll('#menu .nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('#pageTitle').textContent = PAGES[page][0];
  run(PAGES[page][1])();
  refreshOverdueBadge();
}
document.querySelectorAll('#menu .nav-link').forEach(a => a.onclick = () => go(a.dataset.page));

async function refreshOverdueBadge() {
  const s = await api('/api/stats').catch(() => null);
  if (!s) return;
  const b = $('#overdueBadge');
  b.textContent = s.overdue;
  b.classList.toggle('d-none', !s.overdue);
}

// ===== Tổng quan =====
async function loadDashboard() {
  const s = await api('/api/stats');
  const cards = [
    ['Đầu sách', s.titles, 'bi-journal-bookmark', '#e8f0fe', '#1a73e8', `${s.copies} bản sách`],
    ['Độc giả', s.readers, 'bi-people', '#e6f4ea', '#188038', 'đã cấp thẻ'],
    ['Đang mượn', s.borrowing, 'bi-arrow-left-right', '#fef7e0', '#b06000', 'phiếu chưa trả'],
    ['Quá hạn', s.overdue, 'bi-exclamation-triangle', '#fce8e6', '#c5221f', 'cần nhắc trả'],
  ];
  $('#statCards').innerHTML = cards.map(([l, n, ic, bg, fg, sub]) => `
    <div class="col-sm-6 col-xl-3"><div class="card stat">
      <div class="icon" style="background:${bg};color:${fg}"><i class="bi ${ic}"></i></div>
      <div><div class="num">${n}</div><div class="lbl">${l} · <span class="small">${sub}</span></div></div>
    </div></div>`).join('');

  const max = Math.max(1, ...s.daily.flatMap(d => [d.borrowed, d.returned]));
  $('#chartDaily').innerHTML = s.daily.map(d => `
    <div class="day"><div class="bars">
      <div class="bar bg-primary" style="height:${d.borrowed / max * 100}%"><span>${d.borrowed || ''}</span></div>
      <div class="bar bg-success" style="height:${d.returned / max * 100}%"><span>${d.returned || ''}</span></div>
    </div><div class="lbl">${d.day}</div></div>`).join('');

  $('#topBooks').innerHTML = s.top_books.length ? s.top_books.map((b, i) => `
    <li class="list-group-item d-flex align-items-center gap-3">
      <span class="badge rounded-pill ${i ? 'bg-secondary' : 'bg-warning text-dark'}">${i + 1}</span>
      <div class="flex-fill"><div class="fw-semibold">${esc(b.title)}</div><div class="small text-muted">${esc(b.author)}</div></div>
      <span class="text-muted small">${b.times} lượt</span></li>`).join('')
    : '<li class="list-group-item text-muted">Chưa có lượt mượn</li>';

  const total = s.categories.reduce((a, c) => a + c.n, 0) || 1;
  $('#catBars').innerHTML = s.categories.map(c => `
    <div class="cat-row"><div class="name">${esc(c.category)}</div>
      <div class="progress"><div class="progress-bar" style="width:${c.n / total * 100}%"></div></div>
      <div class="small text-muted" style="width:60px">${c.n} đầu</div></div>`).join('')
    + `<div class="small text-muted mt-2">Tổng tiền phạt đã thu: <b>${fmtMoney(s.fines)}</b></div>`;
}

// ===== Kho sách =====
let books = [];
async function loadCategories() {
  const cats = await api('/api/categories');
  const sel = $('#bookCategory'), cur = sel.value;
  sel.innerHTML = '<option value="">Tất cả thể loại</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  sel.value = cur;
  $('#categoryList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
}
async function loadBooks() {
  await loadCategories();
  const q = encodeURIComponent($('#bookSearch').value), c = encodeURIComponent($('#bookCategory').value);
  books = await api(`/api/books?q=${q}&category=${c}`);
  $('#bookTable').innerHTML = books.length ? books.map(b => `
    <tr>
      <td class="text-muted">S${String(b.id).padStart(4, '0')}</td>
      <td><div class="fw-semibold">${esc(b.title)}</div>${b.isbn ? `<div class="small text-muted">ISBN ${esc(b.isbn)}</div>` : ''}</td>
      <td>${esc(b.author)}</td>
      <td><span class="badge text-bg-light border">${esc(b.category)}</span></td>
      <td class="small">${esc(b.publisher || '')}${b.publish_year ? ' · ' + b.publish_year : ''}</td>
      <td>${esc(b.shelf || '')}</td>
      <td class="text-center"><span class="badge ${b.available > 0 ? 'bg-success' : 'bg-danger'}">${b.available} / ${b.quantity}</span></td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-primary btn-icon" onclick="editBook(${b.id})" title="Sửa"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger btn-icon" onclick="deleteBook(${b.id})" title="Xóa"><i class="bi bi-trash"></i></button>
      </td></tr>`).join('')
    : '<tr><td colspan="8" class="text-center text-muted py-4">Không có sách phù hợp</td></tr>';
}
$('#bookSearch').oninput = debounce(run(loadBooks));
$('#bookCategory').onchange = run(loadBooks);
$('#btnAddBook').onclick = () => {
  $('#bookForm').reset(); $('#bookForm').id.value = '';
  $('#bookModalTitle').textContent = 'Thêm sách mới';
  modal('bookModal').show();
};
window.editBook = id => {
  const b = books.find(x => x.id === id), f = $('#bookForm');
  for (const k of ['id', 'title', 'isbn', 'author', 'category', 'publisher', 'publish_year', 'shelf', 'quantity']) f[k].value = b[k] ?? '';
  $('#bookModalTitle').textContent = 'Cập nhật thông tin sách';
  modal('bookModal').show();
};
window.deleteBook = run(async id => {
  const b = books.find(x => x.id === id);
  if (!await confirmBox(`Xóa sách "${b.title}"?`)) return;
  await api('/api/books/' + id, { method: 'DELETE' });
  toast('Đã xóa sách'); loadBooks();
});
$('#bookForm').onsubmit = run(async e => {
  e.preventDefault();
  const d = formData(e.target);
  await api(d.id ? '/api/books/' + d.id : '/api/books', { method: d.id ? 'PUT' : 'POST', body: d });
  modal('bookModal').hide(); toast(d.id ? 'Đã cập nhật sách' : 'Đã thêm sách vào kho'); loadBooks();
});

// ===== Độc giả =====
let readers = [];
async function loadReaders() {
  readers = await api('/api/readers?q=' + encodeURIComponent($('#readerSearch').value));
  $('#readerTable').innerHTML = readers.length ? readers.map(r => `
    <tr>
      <td class="fw-semibold">${esc(r.card_id)}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.reader_type)}</td>
      <td class="small">${esc(r.phone || '')}<br><span class="text-muted">${esc(r.email || '')}</span></td>
      <td>${fmtDate(r.card_expiry)} ${r.expired ? '<span class="badge bg-danger">Hết hạn</span>' : ''}</td>
      <td class="text-center">${r.borrowing}${r.overdue ? ` <span class="badge bg-danger" title="Quá hạn">${r.overdue} trễ</span>` : ''}</td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary btn-icon" onclick="readerHistory(${r.id})" title="Lịch sử mượn"><i class="bi bi-clock-history"></i></button>
        <button class="btn btn-sm btn-outline-primary btn-icon" onclick="editReader(${r.id})" title="Sửa"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger btn-icon" onclick="deleteReader(${r.id})" title="Xóa"><i class="bi bi-trash"></i></button>
      </td></tr>`).join('')
    : '<tr><td colspan="7" class="text-center text-muted py-4">Không có độc giả phù hợp</td></tr>';
}
$('#readerSearch').oninput = debounce(run(loadReaders));
$('#btnAddReader').onclick = () => {
  $('#readerForm').reset(); $('#readerForm').id.value = '';
  $('#readerModalTitle').textContent = 'Cấp thẻ độc giả mới';
  modal('readerModal').show();
};
window.editReader = id => {
  const r = readers.find(x => x.id === id), f = $('#readerForm');
  for (const k of ['id', 'name', 'card_id', 'reader_type', 'phone', 'email']) f[k].value = r[k] ?? '';
  f.card_expiry.value = r.card_expiry ? r.card_expiry.slice(0, 10) : '';
  $('#readerModalTitle').textContent = 'Cập nhật độc giả';
  modal('readerModal').show();
};
window.deleteReader = run(async id => {
  const r = readers.find(x => x.id === id);
  if (!await confirmBox(`Xóa độc giả "${r.name}"?`)) return;
  await api('/api/readers/' + id, { method: 'DELETE' });
  toast('Đã xóa độc giả'); loadReaders();
});
window.readerHistory = run(async id => {
  const r = readers.find(x => x.id === id);
  const rows = await api(`/api/readers/${id}/history`);
  $('#historyTitle').textContent = `Lịch sử mượn – ${r.name} (${r.card_id})`;
  $('#historyTable').innerHTML = rows.length ? rows.map(h => `
    <tr><td>#${h.id}</td><td>${esc(h.title)}</td><td>${fmtDate(h.borrow_date)}</td><td>${fmtDate(h.due_date)}</td>
    <td>${h.return_date ? fmtDate(h.return_date) : '<span class="badge bg-warning text-dark">Đang mượn</span>'}</td>
    <td class="text-end">${h.fine ? fmtMoney(h.fine) : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" class="text-center text-muted py-3">Chưa mượn sách lần nào</td></tr>';
  modal('historyModal').show();
});
$('#readerForm').onsubmit = run(async e => {
  e.preventDefault();
  const d = formData(e.target);
  await api(d.id ? '/api/readers/' + d.id : '/api/readers', { method: d.id ? 'PUT' : 'POST', body: d });
  modal('readerModal').hide(); toast(d.id ? 'Đã cập nhật độc giả' : 'Đã cấp thẻ độc giả'); loadReaders();
});

// ===== Mượn / trả =====
function loanStatus(l) {
  if (l.status === 'returned') return `<span class="badge bg-secondary">Đã trả</span>${l.fine ? `<div class="small text-danger">Phạt ${fmtMoney(l.fine)}</div>` : ''}`;
  if (l.is_overdue) return `<span class="badge bg-danger">Quá hạn ${l.days_late} ngày</span>`;
  return `<span class="badge bg-warning text-dark">Đang mượn</span>${l.renew_count ? '<div class="small text-muted">Đã gia hạn</div>' : ''}`;
}
function loanActions(l) {
  if (l.status !== 'borrowing') return '';
  return `<button class="btn btn-sm btn-success" onclick="returnLoan(${l.id})"><i class="bi bi-box-arrow-in-down"></i> Trả</button>
    ${!l.is_overdue && !l.renew_count ? `<button class="btn btn-sm btn-outline-primary" onclick="renewLoan(${l.id})" title="Gia hạn 7 ngày"><i class="bi bi-calendar-plus"></i></button>` : ''}`;
}
let loanReaders = [];
async function loadCirculation() {
  const [rs, bs] = await Promise.all([api('/api/readers'), api('/api/books')]);
  loanReaders = rs;
  const rSel = $('#borrowReader'), cur = rSel.value;
  rSel.innerHTML = '<option value="">-- Chọn độc giả --</option>' + rs.map(r => `<option value="${r.id}">${esc(r.card_id)} – ${esc(r.name)}</option>`).join('');
  rSel.value = cur;
  $('#borrowBook').innerHTML = '<option value="">-- Chọn sách --</option>' + bs.filter(b => b.available > 0)
    .map(b => `<option value="${b.id}">${esc(b.title)} – ${esc(b.author)} (còn ${b.available})</option>`).join('');
  showReaderInfo();
  await loadLoans();
}
function showReaderInfo() {
  const r = loanReaders.find(x => String(x.id) === $('#borrowReader').value);
  $('#readerInfo').innerHTML = !r ? '' :
    `Đang mượn <b>${r.borrowing}/5</b> cuốn · Hạn thẻ ${fmtDate(r.card_expiry)}` +
    (r.expired ? ' · <span class="text-danger">Thẻ hết hạn</span>' : '') +
    (r.overdue ? ` · <span class="text-danger">${r.overdue} sách quá hạn</span>` : '');
}
$('#borrowReader').onchange = showReaderInfo;
async function loadLoans() {
  const loans = await api(`/api/borrow?status=${$('#loanStatus').value}&q=${encodeURIComponent($('#loanSearch').value)}`);
  $('#loanTable').innerHTML = loans.length ? loans.map(l => `
    <tr class="${l.is_overdue ? 'table-danger' : ''}">
      <td>#${l.id}</td><td class="fw-semibold">${esc(l.book_title)}</td>
      <td>${esc(l.reader_name)}<div class="small text-muted">${esc(l.card_id)}</div></td>
      <td>${fmtDate(l.borrow_date)}</td><td>${fmtDate(l.due_date)}</td>
      <td>${loanStatus(l)}</td><td class="text-end text-nowrap">${loanActions(l)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="text-center text-muted py-4">Không có phiếu mượn</td></tr>';
}
$('#loanStatus').onchange = run(loadLoans);
$('#loanSearch').oninput = debounce(run(loadLoans));
$('#borrowForm').onsubmit = run(async e => {
  e.preventDefault();
  const r = await api('/api/borrow', { method: 'POST', body: formData(e.target) });
  toast(`Đã lập phiếu mượn #${r.id}, hạn trả ${fmtDate(r.due_date)}`);
  $('#borrowBook').value = '';
  loadCirculation(); refreshOverdueBadge();
});
window.returnLoan = run(async id => {
  if (!await confirmBox(`Xác nhận độc giả trả sách cho phiếu #${id}?`)) return;
  const r = await api(`/api/borrow/${id}/return`, { method: 'POST' });
  toast(r.fine ? `Đã trả sách. Trễ hạn – thu phạt ${fmtMoney(r.fine)}` : 'Đã trả sách đúng hạn', r.fine ? 'warning' : 'success');
  PAGES[location.hash.slice(1)]?.[1](); refreshOverdueBadge();
});
window.renewLoan = run(async id => {
  const r = await api(`/api/borrow/${id}/renew`, { method: 'POST' });
  toast(`Đã gia hạn phiếu #${id} đến ${fmtDate(r.due_date)}`); loadLoans();
});

// ===== Quá hạn =====
async function loadOverdue() {
  const rows = await api('/api/borrow?status=overdue');
  $('#overdueTable').innerHTML = rows.length ? rows.map(l => `
    <tr><td>#${l.id}</td><td class="fw-semibold">${esc(l.book_title)}</td>
      <td>${esc(l.reader_name)}<div class="small text-muted">${esc(l.card_id)}</div></td>
      <td>${fmtDate(l.due_date)}</td><td class="text-center"><span class="badge bg-danger">${l.days_late}</span></td>
      <td class="text-end">${fmtMoney(l.days_late * 5000)}</td>
      <td class="text-end"><button class="btn btn-sm btn-success" onclick="returnLoan(${l.id})">Nhận trả</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="text-center text-muted py-4"><i class="bi bi-emoji-smile"></i> Không có sách quá hạn</td></tr>';
}

// ===== Tài khoản =====
async function loadUsers() {
  const users = await api('/api/users');
  $('#userTable').innerHTML = users.map(u => `
    <tr><td class="fw-semibold">${esc(u.username)}</td><td>${esc(u.full_name)}</td>
      <td>${u.role === 'admin' ? '<span class="badge bg-primary">Quản trị</span>' : '<span class="badge bg-secondary">Thủ thư</span>'}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td class="text-end">${u.id !== currentUser.id ? `<button class="btn btn-sm btn-outline-danger btn-icon" onclick="deleteUser(${u.id}, '${esc(u.username)}')"><i class="bi bi-trash"></i></button>` : ''}</td></tr>`).join('');
}
$('#userForm').onsubmit = run(async e => {
  e.preventDefault();
  await api('/api/users', { method: 'POST', body: formData(e.target) });
  e.target.reset(); toast('Đã tạo tài khoản'); loadUsers();
});
window.deleteUser = run(async (id, name) => {
  if (!await confirmBox(`Xóa tài khoản "${name}"?`)) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  toast('Đã xóa tài khoản'); loadUsers();
});

// ===== Khởi động =====
api('/api/me').then(r => showApp(r.user)).catch(showLogin);
