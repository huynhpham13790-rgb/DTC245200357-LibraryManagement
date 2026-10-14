const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
app.disable('x-powered-by'); // không lộ công nghệ backend
const port = process.env.PORT || 3000;

// Quy định nghiệp vụ thư viện
const MAX_BORROW_PER_READER = 5;   // số sách tối đa một độc giả được mượn cùng lúc
const DEFAULT_LOAN_DAYS = 14;      // thời hạn mượn mặc định
const RENEW_DAYS = 7;              // số ngày cộng thêm khi gia hạn
const MAX_RENEW = 1;               // số lần gia hạn tối đa
const FINE_PER_DAY = 5000;         // tiền phạt trả muộn (VNĐ/ngày)
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Express 4 không tự bắt lỗi của async handler -> chuyển lỗi sang middleware xử lý lỗi
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (route, ...handlers) => handlers.length === 0 ? orig(route)
    : orig(route, ...handlers.map(h => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
}

// ===== Prometheus Metrics =====
client.collectDefaultMetrics({ register: client.register });
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests count',
  labelNames: ['method', 'route', 'status']
});
const loginCounter = new client.Counter({
  name: 'library_login_total',
  help: 'Số lần đăng nhập theo kết quả',
  labelNames: ['result']
});
const loanCounter = new client.Counter({
  name: 'library_loan_operations_total',
  help: 'Số thao tác mượn/trả/gia hạn',
  labelNames: ['operation']
});

app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.on('finish', () => {
    // Dùng route pattern (vd /api/books/:id) để tránh bùng nổ label
    const route = req.route ? req.baseUrl + req.route.path : (req.path.startsWith('/api') ? 'unmatched' : req.path);
    httpRequestCounter.inc({ method: req.method, route, status: res.statusCode });
  });
  next();
});

// ===== PostgreSQL =====
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'libadmin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'library_system',
  port: 5432,
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// Khởi tạo / nâng cấp CSDL (idempotent, giữ nguyên dữ liệu cũ)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      author VARCHAR(255) NOT NULL
    );
    ALTER TABLE books ADD COLUMN IF NOT EXISTS isbn VARCHAR(20);
    ALTER TABLE books ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Khác';
    ALTER TABLE books ADD COLUMN IF NOT EXISTS publisher VARCHAR(255);
    ALTER TABLE books ADD COLUMN IF NOT EXISTS publish_year INT;
    ALTER TABLE books ADD COLUMN IF NOT EXISTS shelf VARCHAR(50);
    ALTER TABLE books ADD COLUMN IF NOT EXISTS quantity INT NOT NULL DEFAULT 1 CHECK (quantity >= 0);
    ALTER TABLE books ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS readers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      card_id VARCHAR(50) UNIQUE NOT NULL,
      phone VARCHAR(50)
    );
    ALTER TABLE readers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
    ALTER TABLE readers ADD COLUMN IF NOT EXISTS reader_type VARCHAR(50) DEFAULT 'Sinh viên';
    ALTER TABLE readers ADD COLUMN IF NOT EXISTS card_expiry DATE DEFAULT (CURRENT_DATE + INTERVAL '4 years');
    ALTER TABLE readers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS borrow_records (
      id SERIAL PRIMARY KEY,
      book_id INT REFERENCES books(id),
      reader_id INT REFERENCES readers(id),
      borrow_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      return_date TIMESTAMP,
      status VARCHAR(50) DEFAULT 'borrowing'
    );
    ALTER TABLE borrow_records ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;
    ALTER TABLE borrow_records ADD COLUMN IF NOT EXISTS renew_count INT NOT NULL DEFAULT 0;
    ALTER TABLE borrow_records ADD COLUMN IF NOT EXISTS fine INT NOT NULL DEFAULT 0;
    ALTER TABLE borrow_records ADD COLUMN IF NOT EXISTS librarian VARCHAR(100);
    UPDATE borrow_records SET due_date = borrow_date + INTERVAL '${DEFAULT_LOAN_DAYS} days' WHERE due_date IS NULL;
    CREATE INDEX IF NOT EXISTS idx_borrow_status ON borrow_records(status);

    CREATE TABLE IF NOT EXISTS librarians (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'librarian' CHECK (role IN ('admin', 'librarian')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Phiên bản cũ có cột books.status -> chuyển sang mô hình số lượng bản sao rồi bỏ cột
  await pool.query('ALTER TABLE books DROP COLUMN IF EXISTS status');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM librarians');
  if (rows[0].n === 0) {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) throw new Error('Thiếu biến môi trường ADMIN_PASSWORD để tạo tài khoản quản trị đầu tiên');
    await pool.query("INSERT INTO librarians (username, full_name, password_hash, role) VALUES ('admin', 'Quản trị viên', $1, 'admin')", [hashPassword(pw)]);
    console.log('Đã tạo tài khoản quản trị mặc định: admin');
  }
  console.log('Database initialized successfully!');
}

// ===== Phiên đăng nhập (cookie HttpOnly, lưu trong bộ nhớ) =====
const sessions = new Map();
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(sid); return null; }
  return { sid, ...s };
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' });
  req.user = s.user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ quản trị viên được thực hiện thao tác này' });
  next();
}

// Chống dò mật khẩu: tối đa 5 lần sai / 15 phút cho mỗi IP
const loginFails = new Map();
function tooManyFails(ip) {
  const f = loginFails.get(ip);
  if (!f) return false;
  if (f.until < Date.now()) { loginFails.delete(ip); return false; }
  return f.count >= 5;
}

// ===== Endpoint không cần đăng nhập =====
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/healthz', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.post('/api/login', async (req, res) => {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  if (tooManyFails(ip)) {
    loginCounter.inc({ result: 'blocked' });
    return res.status(429).json({ error: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' });
  }
  const { username, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM librarians WHERE username = $1', [String(username || '')]);
  if (!rows[0] || !verifyPassword(String(password || ''), rows[0].password_hash)) {
    const f = loginFails.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    f.count++; loginFails.set(ip, f);
    loginCounter.inc({ result: 'failed' });
    console.warn(`LOGIN_FAILED user=${username} ip=${ip}`);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  loginFails.delete(ip);
  const sid = crypto.randomBytes(32).toString('hex');
  const u = rows[0];
  sessions.set(sid, { user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role }, expires: Date.now() + SESSION_TTL_MS });
  res.cookie('sid', sid, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: SESSION_TTL_MS, path: '/' });
  loginCounter.inc({ result: 'success' });
  console.log(`LOGIN_SUCCESS user=${u.username} ip=${ip}`);
  res.json({ user: sessions.get(sid).user });
});

// ===== Từ đây trở xuống bắt buộc đăng nhập =====
app.use('/api', requireAuth);

app.post('/api/logout', (req, res) => {
  sessions.delete(parseCookies(req).sid);
  res.clearCookie('sid', { path: '/' });
  res.json({ success: true });
});
app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.post('/api/me/password', async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 10) return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 10 ký tự' });
  const { rows } = await pool.query('SELECT password_hash FROM librarians WHERE id = $1', [req.user.id]);
  if (!verifyPassword(String(old_password || ''), rows[0].password_hash)) return res.status(400).json({ error: 'Mật khẩu cũ không đúng' });
  await pool.query('UPDATE librarians SET password_hash = $1 WHERE id = $2', [hashPassword(new_password), req.user.id]);
  res.json({ success: true });
});

// ----- Thống kê tổng quan -----
app.get('/api/stats', async (req, res) => {
  const [totals, daily, top, cats] = await Promise.all([
    pool.query(`SELECT
      (SELECT COUNT(*) FROM books)::int AS titles,
      (SELECT COALESCE(SUM(quantity),0) FROM books)::int AS copies,
      (SELECT COUNT(*) FROM readers)::int AS readers,
      (SELECT COUNT(*) FROM borrow_records WHERE status = 'borrowing')::int AS borrowing,
      (SELECT COUNT(*) FROM borrow_records WHERE status = 'borrowing' AND due_date < NOW())::int AS overdue,
      (SELECT COALESCE(SUM(fine),0) FROM borrow_records)::int AS fines`),
    pool.query(`SELECT to_char(d, 'DD/MM') AS day,
        (SELECT COUNT(*) FROM borrow_records WHERE borrow_date::date = d)::int AS borrowed,
        (SELECT COUNT(*) FROM borrow_records WHERE return_date::date = d)::int AS returned
      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') AS d`),
    pool.query(`SELECT b.title, b.author, COUNT(br.id)::int AS times
      FROM books b JOIN borrow_records br ON br.book_id = b.id
      GROUP BY b.id ORDER BY times DESC, b.title LIMIT 5`),
    pool.query(`SELECT category, COUNT(*)::int AS n FROM books GROUP BY category ORDER BY n DESC`)
  ]);
  res.json({ ...totals.rows[0], daily: daily.rows, top_books: top.rows, categories: cats.rows });
});

// ----- Quản lý sách -----
const BOOK_SELECT = `
  SELECT b.*, (b.quantity - COUNT(br.id))::int AS available
  FROM books b LEFT JOIN borrow_records br ON br.book_id = b.id AND br.status = 'borrowing'`;

app.get('/api/books', async (req, res) => {
  const { q = '', category = '' } = req.query;
  const { rows } = await pool.query(`${BOOK_SELECT}
    WHERE ($1 = '' OR b.title ILIKE '%' || $1 || '%' OR b.author ILIKE '%' || $1 || '%' OR b.isbn ILIKE '%' || $1 || '%')
      AND ($2 = '' OR b.category = $2)
    GROUP BY b.id ORDER BY b.id DESC`, [String(q), String(category)]);
  res.json(rows);
});
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT DISTINCT category FROM books WHERE category IS NOT NULL ORDER BY category');
  res.json(rows.map(r => r.category));
});

function bookFields(body) {
  const title = String(body.title || '').trim();
  const author = String(body.author || '').trim();
  const quantity = parseInt(body.quantity ?? 1, 10);
  const year = body.publish_year ? parseInt(body.publish_year, 10) : null;
  if (!title || !author) return { error: 'Tên sách và tác giả là bắt buộc' };
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000) return { error: 'Số lượng không hợp lệ (0 – 1000)' };
  if (year !== null && (year < 1000 || year > new Date().getFullYear())) return { error: 'Năm xuất bản không hợp lệ' };
  return { values: [title, author, body.isbn || null, body.category || 'Khác', body.publisher || null, year, body.shelf || null, quantity] };
}
app.post('/api/books', async (req, res) => {
  const f = bookFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const { rows } = await pool.query(
    'INSERT INTO books (title, author, isbn, category, publisher, publish_year, shelf, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', f.values);
  res.status(201).json(rows[0]);
});
app.put('/api/books/:id', async (req, res) => {
  const f = bookFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const { rows: [cur] } = await pool.query("SELECT COUNT(*)::int AS n FROM borrow_records WHERE book_id = $1 AND status = 'borrowing'", [req.params.id]);
  if (f.values[7] < cur.n) return res.status(400).json({ error: `Đang có ${cur.n} cuốn được mượn, số lượng không được nhỏ hơn` });
  const r = await pool.query(
    'UPDATE books SET title=$1, author=$2, isbn=$3, category=$4, publisher=$5, publish_year=$6, shelf=$7, quantity=$8 WHERE id=$9 RETURNING *',
    [...f.values, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Không tìm thấy sách' });
  res.json(r.rows[0]);
});
app.delete('/api/books/:id', async (req, res) => {
  const { rows: [h] } = await pool.query('SELECT COUNT(*)::int AS n FROM borrow_records WHERE book_id = $1', [req.params.id]);
  if (h.n > 0) return res.status(409).json({ error: 'Sách đã có lịch sử mượn, không thể xóa (có thể đặt số lượng = 0)' });
  const r = await pool.query('DELETE FROM books WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Không tìm thấy sách' });
  res.json({ success: true });
});

// ----- Quản lý độc giả -----
app.get('/api/readers', async (req, res) => {
  const q = String(req.query.q || '');
  const { rows } = await pool.query(`
    SELECT r.*,
      COUNT(br.id) FILTER (WHERE br.status = 'borrowing')::int AS borrowing,
      COUNT(br.id) FILTER (WHERE br.status = 'borrowing' AND br.due_date < NOW())::int AS overdue,
      (r.card_expiry < CURRENT_DATE) AS expired
    FROM readers r LEFT JOIN borrow_records br ON br.reader_id = r.id
    WHERE ($1 = '' OR r.name ILIKE '%' || $1 || '%' OR r.card_id ILIKE '%' || $1 || '%' OR r.phone ILIKE '%' || $1 || '%')
    GROUP BY r.id ORDER BY r.id DESC`, [q]);
  res.json(rows);
});
app.get('/api/readers/:id/history', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT br.*, b.title FROM borrow_records br JOIN books b ON b.id = br.book_id
    WHERE br.reader_id = $1 ORDER BY br.id DESC`, [req.params.id]);
  res.json(rows);
});

function readerFields(body) {
  const name = String(body.name || '').trim();
  const card_id = String(body.card_id || '').trim().toUpperCase();
  if (!name || !card_id) return { error: 'Họ tên và mã thẻ là bắt buộc' };
  if (!/^[A-Z0-9_-]{3,50}$/.test(card_id)) return { error: 'Mã thẻ chỉ gồm chữ, số, - và _' };
  if (body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return { error: 'Email không hợp lệ' };
  if (body.phone && !/^[0-9+ ]{8,15}$/.test(body.phone)) return { error: 'Số điện thoại không hợp lệ' };
  return { values: [name, card_id, body.phone || null, body.email || null, body.reader_type || 'Sinh viên', body.card_expiry || null] };
}
app.post('/api/readers', async (req, res) => {
  const f = readerFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO readers (name, card_id, phone, email, reader_type, card_expiry)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE + INTERVAL '4 years')) RETURNING *`, f.values);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Mã thẻ đã tồn tại' });
    throw e;
  }
});
app.put('/api/readers/:id', async (req, res) => {
  const f = readerFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  try {
    const r = await pool.query(
      `UPDATE readers SET name=$1, card_id=$2, phone=$3, email=$4, reader_type=$5, card_expiry=COALESCE($6::date, card_expiry)
       WHERE id=$7 RETURNING *`, [...f.values, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Không tìm thấy độc giả' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Mã thẻ đã tồn tại' });
    throw e;
  }
});
app.delete('/api/readers/:id', async (req, res) => {
  const { rows: [h] } = await pool.query('SELECT COUNT(*)::int AS n FROM borrow_records WHERE reader_id = $1', [req.params.id]);
  if (h.n > 0) return res.status(409).json({ error: 'Độc giả đã có lịch sử mượn, không thể xóa' });
  const r = await pool.query('DELETE FROM readers WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Không tìm thấy độc giả' });
  res.json({ success: true });
});

// ----- Mượn / trả / gia hạn -----
app.get('/api/borrow', async (req, res) => {
  const status = String(req.query.status || '');
  const q = String(req.query.q || '');
  const { rows } = await pool.query(`
    SELECT br.*, b.title AS book_title, r.name AS reader_name, r.card_id,
      (br.status = 'borrowing' AND br.due_date < NOW()) AS is_overdue,
      GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(br.return_date, NOW()) - br.due_date)) / 86400))::int AS days_late
    FROM borrow_records br
    JOIN books b ON br.book_id = b.id
    JOIN readers r ON br.reader_id = r.id
    WHERE ($1 = '' OR ($1 = 'overdue' AND br.status = 'borrowing' AND br.due_date < NOW()) OR br.status = $1)
      AND ($2 = '' OR b.title ILIKE '%' || $2 || '%' OR r.name ILIKE '%' || $2 || '%' OR r.card_id ILIKE '%' || $2 || '%')
    ORDER BY br.id DESC LIMIT 500`, [status, q]);
  res.json(rows);
});

// Chạy fn trong 1 transaction trên cùng một kết nối
async function withTx(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}
class BizError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

app.post('/api/borrow', async (req, res) => {
  const { book_id, reader_id } = req.body;
  const days = parseInt(req.body.days || DEFAULT_LOAN_DAYS, 10);
  if (!book_id || !reader_id) return res.status(400).json({ error: 'Chưa chọn sách hoặc độc giả' });
  if (!(days >= 1 && days <= 60)) return res.status(400).json({ error: 'Số ngày mượn phải từ 1 đến 60' });
  const record = await withTx(async db => {
    // Khóa dòng sách để 2 thủ thư không cho mượn cùng một bản cuối cùng
    const { rows: [book] } = await db.query('SELECT * FROM books WHERE id = $1 FOR UPDATE', [book_id]);
    if (!book) throw new BizError(404, 'Không tìm thấy sách');
    const { rows: [{ n: out }] } = await db.query("SELECT COUNT(*)::int AS n FROM borrow_records WHERE book_id = $1 AND status = 'borrowing'", [book_id]);
    if (out >= book.quantity) throw new BizError(409, `Sách "${book.title}" đã được mượn hết`);

    await db.query('SELECT id FROM readers WHERE id = $1 FOR UPDATE', [reader_id]);
    const { rows: [reader] } = await db.query(`
      SELECT r.*, (r.card_expiry < CURRENT_DATE) AS expired,
        COUNT(br.id) FILTER (WHERE br.status = 'borrowing')::int AS borrowing,
        COUNT(br.id) FILTER (WHERE br.status = 'borrowing' AND br.due_date < NOW())::int AS overdue,
        COUNT(br.id) FILTER (WHERE br.status = 'borrowing' AND br.book_id = $2)::int AS same_book
      FROM readers r LEFT JOIN borrow_records br ON br.reader_id = r.id
      WHERE r.id = $1 GROUP BY r.id`, [reader_id, book_id]);
    if (!reader) throw new BizError(404, 'Không tìm thấy độc giả');
    if (reader.expired) throw new BizError(409, 'Thẻ độc giả đã hết hạn');
    if (reader.overdue > 0) throw new BizError(409, `Độc giả đang có ${reader.overdue} sách quá hạn chưa trả`);
    if (reader.borrowing >= MAX_BORROW_PER_READER) throw new BizError(409, `Độc giả đã mượn tối đa ${MAX_BORROW_PER_READER} cuốn`);
    if (reader.same_book > 0) throw new BizError(409, 'Độc giả đang mượn cuốn sách này');

    const { rows: [rec] } = await db.query(`
      INSERT INTO borrow_records (book_id, reader_id, due_date, librarian)
      VALUES ($1, $2, NOW() + make_interval(days => $3), $4) RETURNING *`, [book_id, reader_id, days, req.user.username]);
    return rec;
  });
  loanCounter.inc({ operation: 'borrow' });
  console.log(`BORROW record=${record.id} book=${book_id} reader=${reader_id} by=${req.user.username}`);
  res.status(201).json(record);
});

app.post('/api/borrow/:id/return', async (req, res) => {
  const rec = await withTx(async db => {
    const { rows: [r] } = await db.query(`
      UPDATE borrow_records SET status = 'returned', return_date = NOW(),
        fine = GREATEST(0, CEIL(EXTRACT(EPOCH FROM (NOW() - due_date)) / 86400))::int * $2
      WHERE id = $1 AND status = 'borrowing' RETURNING *`, [req.params.id, FINE_PER_DAY]);
    if (!r) throw new BizError(404, 'Không tìm thấy phiếu đang mượn');
    return r;
  });
  loanCounter.inc({ operation: 'return' });
  console.log(`RETURN record=${rec.id} fine=${rec.fine} by=${req.user.username}`);
  res.json(rec);
});

app.post('/api/borrow/:id/renew', async (req, res) => {
  const rec = await withTx(async db => {
    const { rows: [r] } = await db.query("SELECT * FROM borrow_records WHERE id = $1 AND status = 'borrowing' FOR UPDATE", [req.params.id]);
    if (!r) throw new BizError(404, 'Không tìm thấy phiếu đang mượn');
    if (new Date(r.due_date) < new Date()) throw new BizError(409, 'Phiếu đã quá hạn, không thể gia hạn');
    if (r.renew_count >= MAX_RENEW) throw new BizError(409, `Mỗi phiếu chỉ được gia hạn ${MAX_RENEW} lần`);
    const { rows: [u] } = await db.query(
      `UPDATE borrow_records SET due_date = due_date + INTERVAL '${RENEW_DAYS} days', renew_count = renew_count + 1 WHERE id = $1 RETURNING *`, [r.id]);
    return u;
  });
  loanCounter.inc({ operation: 'renew' });
  res.json(rec);
});

// ----- Tài khoản thủ thư (chỉ admin) -----
app.get('/api/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, full_name, role, created_at FROM librarians ORDER BY id');
  res.json(rows);
});
app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, full_name, password, role } = req.body;
  if (!/^[a-z0-9_.]{3,30}$/.test(username || '')) return res.status(400).json({ error: 'Tên đăng nhập 3–30 ký tự: a-z, 0-9, _ .' });
  if (!full_name) return res.status(400).json({ error: 'Thiếu họ tên' });
  if (!password || password.length < 10) return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 10 ký tự' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO librarians (username, full_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, full_name, role',
      [username, full_name, hashPassword(password), role === 'admin' ? 'admin' : 'librarian']);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    throw e;
  }
});
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (String(req.user.id) === req.params.id) return res.status(400).json({ error: 'Không thể tự xóa tài khoản của mình' });
  await pool.query('DELETE FROM librarians WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API không tồn tại' }));

// ----- Giao diện (SPA tĩnh) -----
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

// Bắt lỗi chung: tránh crash container khi DB lỗi
app.use((err, req, res, next) => {
  if (err instanceof BizError) return res.status(err.status).json({ error: err.message });
  if (err.code === '22P02') return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  console.error('Request error:', req.method, req.path, err.message);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

// Dọn phiên hết hạn định kỳ
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
}, 10 * 60 * 1000).unref();

// Chờ PostgreSQL sẵn sàng (thử lại tối đa 30 lần) rồi mới mở cổng
(async () => {
  for (let i = 1; ; i++) {
    try { await initDB(); break; } catch (err) {
      if (i >= 30) { console.error('Database initialization error:', err); process.exit(1); }
      console.warn(`Chưa kết nối được DB (lần ${i}): ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(port, () => console.log('Library management app listening on port ' + port));
})();
