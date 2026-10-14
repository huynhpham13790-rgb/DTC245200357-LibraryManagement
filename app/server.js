const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
const port = process.env.PORT || 3000;

// Prometheus Metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ register: client.register });

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests count',
  labelNames: ['method', 'route', 'status']
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
  });
  next();
});

// PostgreSQL Connection
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'libadmin',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_NAME || 'library_system',
  port: 5432,
});

// Khởi tạo các bảng dữ liệu: sách, độc giả, mượn/trả
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        author VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'available'
      );

      CREATE TABLE IF NOT EXISTS readers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        card_id VARCHAR(50) UNIQUE NOT NULL,
        phone VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS borrow_records (
        id SERIAL PRIMARY KEY,
        book_id INT REFERENCES books(id),
        reader_id INT REFERENCES readers(id),
        borrow_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        return_date TIMESTAMP,
        status VARCHAR(50) DEFAULT 'borrowing'
      );
    `);
    console.log("Database initialized successfully!");
  } catch (err) {
    console.error("Database initialization error:", err);
  }
}
initDB();

// Endpoint Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// APIs Nghiệp vụ
// 1. Quản lý sách
app.get('/api/books', async (req, res) => {
  const result = await pool.query('SELECT * FROM books ORDER BY id DESC');
  res.json(result.rows);
});
app.post('/api/books', async (req, res) => {
  const { title, author } = req.body;
  if (!title || !author) return res.status(400).json({ error: 'Thiếu thông tin' });
  const result = await pool.query('INSERT INTO books (title, author) VALUES ($1, $2) RETURNING *', [title, author]);
  res.status(201).json(result.rows[0]);
});

// 2. Quản lý độc giả
app.get('/api/readers', async (req, res) => {
  const result = await pool.query('SELECT * FROM readers ORDER BY id DESC');
  res.json(result.rows);
});
app.post('/api/readers', async (req, res) => {
  const { name, card_id, phone } = req.body;
  if (!name || !card_id) return res.status(400).json({ error: 'Thiếu thông tin' });
  const result = await pool.query('INSERT INTO readers (name, card_id, phone) VALUES ($1, $2, $3) RETURNING *', [name, card_id, phone]);
  res.status(201).json(result.rows[0]);
});

// 3. Mượn / Trả sách
app.get('/api/borrow', async (req, res) => {
  const result = await pool.query(`
    SELECT br.id, b.title as book_title, r.name as reader_name, br.borrow_date, br.status 
    FROM borrow_records br
    JOIN books b ON br.book_id = b.id
    JOIN readers r ON br.reader_id = r.id
    ORDER BY br.id DESC
  `);
  res.json(result.rows);
});
app.post('/api/borrow', async (req, res) => {
  const { book_id, reader_id } = req.body;
  await pool.query('BEGIN');
  await pool.query('INSERT INTO borrow_records (book_id, reader_id) VALUES ($1, $2)', [book_id, reader_id]);
  await pool.query("UPDATE books SET status = 'borrowed' WHERE id = $1", [book_id]);
  await pool.query('COMMIT');
  res.json({ success: true });
});
app.post('/api/return', async (req, res) => {
  const { record_id, book_title } = req.body;
  await pool.query('BEGIN');
  await pool.query("UPDATE borrow_records SET status = 'returned', return_date = CURRENT_TIMESTAMP WHERE id = $1", [record_id]);
  await pool.query("UPDATE books SET status = 'available' WHERE title = $1", [book_title]);
  await pool.query('COMMIT');
  res.json({ success: true });
});

// Giao diện Web đầy đủ 3 chức năng
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Hệ thống Quản lý Thư viện - E-Library</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background-color: #f8f9fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .nav-tabs .nav-link.active { font-weight: bold; border-top: 3px solid #0d6efd; }
  </style>
</head>
<body class="container py-4">
  <header class="pb-3 mb-4 border-bottom d-flex justify-content-between align-items-center">
    <h2 class="text-primary fw-bold mb-0">📚 Hệ thống Quản lý Thư viện - E-Library</h2>
    <span class="badge bg-success">Hệ thống Trực tuyến (SSL/HTTPS)</span>
  </header>

  <ul class="nav nav-tabs mb-4" id="libTab" role="tablist">
    <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#books-tab">📖 Quản lý Sách</button></li>
    <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#readers-tab">👤 Quản lý Độc giả</button></li>
    <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#borrow-tab">🔄 Mượn & Trả sách</button></li>
  </ul>

  <div class="tab-content">
    <!-- TAB QUẢN LÝ SÁCH -->
    <div class="tab-pane fade show active" id="books-tab">
      <div class="row">
        <div class="col-md-4">
          <div class="card p-3 shadow-sm mb-3">
            <h5 class="card-title text-secondary">Thêm Sách Mới</h5>
            <div class="mb-2"><input type="text" id="b_title" class="form-control" placeholder="Tên sách..."></div>
            <div class="mb-2"><input type="text" id="b_author" class="form-control" placeholder="Tác giả..."></div>
            <button class="btn btn-primary w-100" onclick="addBook()">+ Lưu Sách</button>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card p-3 shadow-sm">
            <h5 class="card-title text-secondary">Danh Mục Sách Hiện Có</h5>
            <table class="table table-hover mt-2">
              <thead class="table-light"><tr><th>ID</th><th>Tên sách</th><th>Tác giả</th><th>Trạng thái</th></tr></thead>
              <tbody id="bookList"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB QUẢN LÝ ĐỘC GIẢ -->
    <div class="tab-pane fade" id="readers-tab">
      <div class="row">
        <div class="col-md-4">
          <div class="card p-3 shadow-sm mb-3">
            <h5 class="card-title text-secondary">Đăng Ký Độc Giả</h5>
            <div class="mb-2"><input type="text" id="r_name" class="form-control" placeholder="Họ và tên..."></div>
            <div class="mb-2"><input type="text" id="r_card" class="form-control" placeholder="Mã thẻ SV (VD: DTC01)..."></div>
            <div class="mb-2"><input type="text" id="r_phone" class="form-control" placeholder="Số điện thoại..."></div>
            <button class="btn btn-success w-100" onclick="addReader()">+ Đăng Ký</button>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card p-3 shadow-sm">
            <h5 class="card-title text-secondary">Danh Sách Độc Giả</h5>
            <table class="table table-hover mt-2">
              <thead class="table-light"><tr><th>ID</th><th>Họ tên</th><th>Mã thẻ</th><th>Điện thoại</th></tr></thead>
              <tbody id="readerList"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB MƯỢN TRẢ SÁCH -->
    <div class="tab-pane fade" id="borrow-tab">
      <div class="row">
        <div class="col-md-4">
          <div class="card p-3 shadow-sm mb-3">
            <h5 class="card-title text-secondary">Tạo Phiếu Mượn Sách</h5>
            <div class="mb-2">
              <label class="form-label small text-muted">Chọn sách (Có sẵn):</label>
              <select id="borrow_book" class="form-select"></select>
            </div>
            <div class="mb-2">
              <label class="form-label small text-muted">Chọn độc giả:</label>
              <select id="borrow_reader" class="form-select"></select>
            </div>
            <button class="btn btn-warning w-100 text-dark" onclick="borrowBook()">Xác Nhận Mượn</button>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card p-3 shadow-sm">
            <h5 class="card-title text-secondary">Lịch Sử Mượn / Trả Sách</h5>
            <table class="table table-hover mt-2">
              <thead class="table-light"><tr><th>Mã phiếu</th><th>Tên sách</th><th>Độc giả</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
              <tbody id="borrowList"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    async function loadData() {
      const books = await (await fetch('/api/books')).json();
      const readers = await (await fetch('/api/readers')).json();
      const borrows = await (await fetch('/api/borrow')).json();

      document.getElementById('bookList').innerHTML = books.map(b => 
        '<tr><td>' + b.id + '</td><td><b>' + b.title + '</b></td><td>' + b.author + '</td><td>' + 
        (b.status === 'available' ? '<span class="badge bg-success">Có sẵn</span>' : '<span class="badge bg-danger">Đang mượn</span>') + '</td></tr>'
      ).join('');

      document.getElementById('readerList').innerHTML = readers.map(r => 
        '<tr><td>' + r.id + '</td><td><b>' + r.name + '</b></td><td>' + r.card_id + '</td><td>' + (r.phone||'') + '</td></tr>'
      ).join('');

      const availBooks = books.filter(b => b.status === 'available');
      document.getElementById('borrow_book').innerHTML = availBooks.map(b => '<option value="' + b.id + '">' + b.title + '</option>').join('');
      document.getElementById('borrow_reader').innerHTML = readers.map(r => '<option value="' + r.id + '">' + r.name + ' (' + r.card_id + ')</option>').join('');

      document.getElementById('borrowList').innerHTML = borrows.map(br => 
        '<tr><td>#' + br.id + '</td><td>' + br.book_title + '</td><td>' + br.reader_name + '</td><td>' + 
        (br.status === 'borrowing' ? '<span class="badge bg-warning text-dark">Đang mượn</span>' : '<span class="badge bg-secondary">Đã trả</span>') + 
        '</td><td>' + 
        (br.status === 'borrowing' ? '<button class="btn btn-sm btn-outline-success" onclick="returnBook(' + br.id + ', \\'' + br.book_title + '\\')">Trả sách</button>' : 'Đã hoàn tất') + '</td></tr>'
      ).join('');
    }

    async function addBook() {
      const title = document.getElementById('b_title').value;
      const author = document.getElementById('b_author').value;
      if (!title || !author) return alert('Vui lòng điền đủ tên sách và tác giả');
      await fetch('/api/books', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title, author}) });
      document.getElementById('b_title').value = ''; document.getElementById('b_author').value = '';
      loadData();
    }

    async function addReader() {
      const name = document.getElementById('r_name').value;
      const card_id = document.getElementById('r_card').value;
      const phone = document.getElementById('r_phone').value;
      if (!name || !card_id) return alert('Vui lòng điền tên và mã thẻ');
      await fetch('/api/readers', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, card_id, phone}) });
      document.getElementById('r_name').value = ''; document.getElementById('r_card').value = ''; document.getElementById('r_phone').value = '';
      loadData();
    }

    async function borrowBook() {
      const book_id = document.getElementById('borrow_book').value;
      const reader_id = document.getElementById('borrow_reader').value;
      if (!book_id || !reader_id) return alert('Chưa chọn sách hoặc độc giả');
      await fetch('/api/borrow', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({book_id, reader_id}) });
      loadData();
    }

    async function returnBook(record_id, book_title) {
      await fetch('/api/return', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({record_id, book_title}) });
      loadData();
    }

    loadData();
  </script>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log('Library management app listening on port ' + port);
});
