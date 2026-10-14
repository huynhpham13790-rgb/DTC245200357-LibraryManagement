# HỆ THỐNG QUẢN LÝ THƯ VIỆN (LIBRARY MANAGEMENT SYSTEM)
**Môn học:** Triển khai và Quản trị Hệ thống Phần mềm  
**Đề tài 01:** Hệ thống Quản lý Thư viện  

---

## 1. Danh sách dịch vụ triển khai
- **Web App:** Node.js (Express) quản lý sách & tích hợp endpoint `/metrics`
- **Database:** PostgreSQL 16
- **Database Management Tool:** pgAdmin 4
- **Reverse Proxy & SSL:** Nginx Alpine (HTTPS tự ký, Security Headers)
- **Monitoring (Metrics):** Prometheus + Grafana + cAdvisor + Postgres Exporter + Nginx Exporter
- **Centralized Logging:** Loki + Promtail (LogQL)

---

## 2. Hướng dẫn khởi chạy hệ thống

### Yêu cầu tiên quyết:
- Đã cài đặt Docker và Docker Compose Plugin.
- Đảm bảo các cổng `80` và `443` trên máy tính chưa bị chiếm dụng.

### Các bước cài đặt:
1. Khởi tạo chứng chỉ SSL tự ký:
```bash
mkdir -p nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/key.pem \
  -out nginx/ssl/cert.pem \
  -subj "/C=VN/ST=ThaiNguyen/L=ThaiNguyen/O=ICTU/CN=library.local"
Tạo file biến môi trường .env:

Đoạn mã


DB_USER=libadmin
DB_PASSWORD=123456
DB_NAME=library_system
PGADMIN_EMAIL=admin@library.com
PGADMIN_PASSWORD=123456
GRAFANA_PASSWORD=123456
Khởi chạy toàn bộ hệ thống bằng Docker Compose:

Bash


docker compose up -d --build
3. Danh mục truy cập và tài khoản mặc định
Ứng dụng Web Quản lý thư viện: https://localhost/

Quản trị Database (pgAdmin): https://localhost/pgadmin/

Tài khoản: admin@library.com / 123456

Kết nối DB: Host postgres, Port 5432, User libadmin, Pass 123456, DB library_system

Hệ thống giám sát (Grafana): https://localhost/grafana/

Tài khoản: admin / 123456

4. Các biện pháp Hardening hệ thống đã áp dụng
Non-root Container: Web App chạy dưới quyền USER node thay vì user root.

Network Isolation: Phân chia 3 bridge networks biệt lập (frontend_net, backend_net, monitoring_net). Cơ sở dữ liệu PostgreSQL không publish cổng ra ngoài máy chủ host.

HTTP Security Headers: Nginx kích hoạt X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy.

Giảm diện tích tấn công: Bật server_tokens off trên Nginx; sử dụng các base image rút gọn Alpine Linux.

