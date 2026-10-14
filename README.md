# HỆ THỐNG QUẢN LÝ THƯ VIỆN (LIBRARY MANAGEMENT SYSTEM)
**Môn học:** Triển khai và Quản trị Hệ thống Phần mềm
**Đề tài 01:** Hệ thống Quản lý Thư viện — **SV:** Phạm Văn Huynh — **MSSV:** DTC245200357

---

## 1. Danh sách dịch vụ (11 container, chạy bằng Docker Compose)
| Dịch vụ | Container | Vai trò |
|---|---|---|
| Web App (Node.js/Express) | `lib_app` | Quản lý sách, độc giả, mượn/trả; endpoint `/metrics` |
| PostgreSQL 16 | `lib_postgres` | Cơ sở dữ liệu |
| pgAdmin 4 | `lib_pgadmin` | Công cụ quản trị DB |
| Nginx | `lib_nginx` | Reverse proxy, HTTPS tự ký, security headers |
| Prometheus | `lib_prometheus` | Thu thập metrics |
| cAdvisor / Postgres Exporter / Nginx Exporter | `lib_cadvisor`, `lib_postgres_exporter`, `lib_nginx_exporter` | Metrics container / DB / web server |
| Grafana | `lib_grafana` | Dashboard + Explore (datasource & dashboard được provision sẵn) |
| Loki + Promtail | `lib_loki`, `lib_promtail` | Log tập trung, truy vấn LogQL |

## 2. Hướng dẫn chạy
Yêu cầu: Docker + Docker Compose plugin, cổng 80/443 còn trống.

```bash
# 1. Tạo chứng chỉ SSL tự ký (không commit private key lên Git)
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/key.pem -out nginx/ssl/cert.pem \
  -subj "/C=VN/ST=ThaiNguyen/L=ThaiNguyen/O=ICTU/CN=library.local"

# 2. Tạo file .env và ĐỔI mật khẩu mạnh
cp .env.example .env

# 3. Khởi chạy
docker compose up -d --build
docker compose ps
```

## 3. Địa chỉ truy cập
| Thành phần | URL | Tài khoản |
|---|---|---|
| Web App | https://localhost/ | — |
| pgAdmin | https://localhost/pgadmin/ | `PGADMIN_EMAIL` / `PGADMIN_PASSWORD` trong `.env` |
| Grafana | https://localhost/grafana/ | `admin` / `GRAFANA_PASSWORD` |
| Prometheus | http://localhost:9090 (chỉ từ máy host) | — |

Kết nối DB trong pgAdmin: Host `postgres`, Port `5432`, User/Pass/DB theo `.env`.
Dashboard Grafana: **Dashboards → Library → Library System Overview** (CPU/RAM container, request web, Nginx, PostgreSQL, log lỗi).

## 4. Truy vấn LogQL (Grafana → Explore → Loki)
```logql
{job="nginx"}                                                  # toàn bộ access/error log Nginx
{job="nginx"} | json | status >= 400                          # request lỗi 4xx/5xx
{job="nginx"} |= "/api/borrow"                                 # log nghiệp vụ mượn sách
sum by (status) (count_over_time({job="nginx"} | json [5m]))  # đếm request theo mã trạng thái
```

## 5. Hardening đã áp dụng
1. **Non-root container:** Web App chạy `USER node`; pgAdmin chạy user `pgadmin` (uid 5050) ở cổng 8080.
2. **Hạn chế quyền:** `no-new-privileges` cho mọi container; Web App `read_only` + `cap_drop: ALL`.
3. **Network isolation:** 3 mạng `frontend_net`, `backend_net` (`internal: true`, không ra Internet), `monitoring_net`. PostgreSQL không publish cổng; Prometheus chỉ bind `127.0.0.1`.
4. **Mật khẩu mạnh:** không còn mật khẩu mặc định trong compose — thiếu biến trong `.env` thì compose báo lỗi; `.env` không commit.
5. **Nginx:** HTTPS (TLS 1.2/1.3), HTTP→HTTPS, `server_tokens off`, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, HSTS; chặn `/metrics` từ ngoài; `stub_status` chỉ ở cổng nội bộ 8080.
6. **Ứng dụng:** truy vấn tham số hoá (chống SQL injection), escape HTML (chống XSS), transaction mượn/trả đúng chuẩn.
