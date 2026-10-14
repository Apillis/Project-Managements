# Hướng dẫn cài đặt & chạy thử Apillis PM

## 1. Chạy thử trên máy tính (Windows, chưa cần server)

### 1.1 Cài phần mềm (một lần)

| Phần mềm | Ghi chú |
|---|---|
| Docker Desktop | Bật WSL 2 khi được hỏi. Mở Docker Desktop và đợi trạng thái "Engine running" |
| Node.js 22 LTS | https://nodejs.org |
| Git | https://git-scm.com |

### 1.2 Khởi động backend (Supabase)

Mở PowerShell trong thư mục `pm-app`:

```powershell
npx supabase start
```

Lần đầu mất 5–10 phút để tải image Docker. Khi xong, màn hình in ra:

```
API URL: http://127.0.0.1:54321
Studio URL: http://127.0.0.1:54323
Inbucket URL: http://127.0.0.1:54324
anon key: eyJhbGciOi...
```

Lệnh này tự chạy toàn bộ `supabase/migrations` (cấu trúc bảng, phân quyền, quy trình duyệt) và `supabase/seed.sql` (dữ liệu demo).

### 1.3 Chạy giao diện web

```powershell
cd web
copy .env.example .env      # rồi mở .env, dán "anon key" ở bước trên vào VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Mở trình duyệt tại http://localhost:5173.

### 1.4 Đăng nhập lần đầu

1. Bấm **Đăng ký** và dùng email `@apillis.com`. **Người đăng ký đầu tiên tự động là Quản trị.**
2. Đồng nghiệp tự đăng ký bằng email công ty. Email ngoài tên miền sẽ bị từ chối.
3. Quản trị vào **Cài đặt → Người dùng & vai trò** để tick vai trò cho từng người. Một người có thể giữ nhiều vai trò, ví dụ Kỹ thuật + Trưởng nhóm kỹ thuật.

Email gửi trong môi trường thử không đi ra ngoài mà được giữ lại tại Inbucket: http://127.0.0.1:54324.

### 1.5 Chạy dịch vụ thông báo (không bắt buộc)

```powershell
cd notifier
npm install
$env:DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
$env:SMTP_HOST="127.0.0.1"; $env:SMTP_PORT="54325"; $env:SMTP_FROM="pm@apillis.com"
npm start
```

Sau đó bật **Cài đặt → Chung → notify_email_enabled**.

### 1.6 Dừng / xoá dữ liệu thử

| Lệnh | Tác dụng |
|---|---|
| `npx supabase stop` | Dừng, giữ nguyên dữ liệu |
| `npx supabase db reset` | Xoá sạch dữ liệu, chạy lại migrations + seed |

## 2. Quy trình mẫu để kiểm tra

1. **Kinh doanh:** Báo giá → Gửi duyệt → Ban Giám đốc duyệt → chuyển "Đã gửi khách" → "Thắng" → **Tạo đơn hàng bán** → duyệt SO → **Tạo dự án**. Mã dự án do người dùng tự nhập, ví dụ `IPGOJE601`.
2. **PMO:** mở dự án → tab **Công việc (IDEF0)** → **Tạo từ mẫu vòng đời dự án**:
   - Hệ thống sinh cây A0 → A1…A8, mỗi công việc đã có sẵn mũi tên I/C/O/M.
   - Gán người thực hiện và ngày cho từng công việc.
   - Tab **Tiến độ** hiển thị dạng Gantt.
3. **Kỹ thuật:** tab **BOM** → tạo BOM, thêm dòng → Gửi duyệt → Trưởng nhóm kỹ thuật duyệt → BOM bị khoá. Muốn sửa BOM đã duyệt thì phải tạo **ECO**, duyệt ECO, rồi bấm **Tạo phiên bản BOM mới** (rev B).
4. **Mua hàng:**
   - Trong BOM đã duyệt, bấm **Tạo PR từ BOM** → PM duyệt.
   - Bấm **Tạo PO từ PR**, chọn NCC, nhập đơn giá → Gửi duyệt. PO ≥ 100 triệu cần thêm Ban Giám đốc duyệt.
   - Chuyển PO sang "Đã đặt hàng".
5. **Kho:** **Nhận hàng theo PO** (không thấy giá) → nhập kho, có thể tạo luôn phiếu IQC → xuất kho cho dự án.
6. **QA:**
   - Nếu phiếu kiểm tra **Không đạt**, hệ thống tự mở **NCR** gắn với NCC.
   - Tab **Hồ sơ tuân thủ** → tạo danh mục CE (EU) / UL-NFPA 79 (US).
7. **Xuất Excel:** menu **Xuất Excel**, chọn phân hệ → báo cáo, lọc theo dự án/ngày/trạng thái. Mỗi danh sách cũng có nút **Xuất Excel** riêng.
8. **Nhập dữ liệu cũ:** menu **Nhập dữ liệu cũ** → tải file mẫu → điền → tải lên → kiểm tra lỗi → Nhập.

## 3. Cấu hình trong Cài đặt (quản trị)

| Mục | Nội dung |
|---|---|
| Chung | Tên công ty, tiền tệ gốc, tên miền email, thuế mặc định, bật email / Google Chat, URL webhook |
| Người dùng & vai trò | Gán vai trò, khoá tài khoản nghỉ việc |
| Ma trận phân quyền | Bấm R/W cho từng vai trò × phân hệ, có hiệu lực ngay |
| Ma trận phê duyệt | Mỗi dòng là một bước duyệt của một loại chứng từ, áp dụng theo khoảng giá trị |
| Đánh số chứng từ | Tiền tố, số chữ số, có năm hay không (PO-2026-0001) |
| Tiền tệ & tỷ giá, Thuế | Thêm USD/EUR… và nhập tỷ giá |
| Đơn giá giờ công | Dùng để tính chi phí nhân công của dự án |
| Mẫu vòng đời (IDEF0), Mẫu hồ sơ tuân thủ | Chỉnh sửa mẫu dùng cho dự án mới |

### Google Chat

Trong phòng chat Google, chọn **Ứng dụng & tích hợp → Webhook → Thêm webhook**. Copy URL, dán vào `gchat_webhook_url`, rồi bật `notify_gchat_enabled`.

### Đăng nhập bằng Google (@apillis.com)

1. Tại Google Cloud Console, tạo **OAuth client (Web)**.
2. Đặt Redirect URI:
   - Máy thử: `http://127.0.0.1:54321/auth/v1/callback`
   - Server: `https://pm.apillis.lan/auth/v1/callback`
3. Điền Client ID và Secret:
   - Máy thử: vào `supabase/config.toml` (`[auth.external.google] enabled = true`).
   - Server: vào `.env` (`GOOGLE_ENABLED=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_SECRET`).
4. Đặt `VITE_ENABLE_GOOGLE=true` trong `web/.env`.

## 4. Đưa lên server (khi đã có máy chủ)

Theo bản vẽ APL-IT-PM-001: Ubuntu Server 24.04, IP tĩnh, ổ RAID 1, có UPS.

```bash
curl -fsSL https://raw.githubusercontent.com/Apillis/Project-Managements/main/deploy/scripts/install-server.sh | bash -s -- v1.0.0
nano /opt/apillis-pm/supabase/.env      # SITE_URL, API_EXTERNAL_URL, SUPABASE_PUBLIC_URL = https://pm.apillis.lan, SMTP, ADMIN_IP
/opt/apillis-pm/pm-app/deploy/scripts/deploy.sh v1.0.0
```

| Hạng mục | Cách xử lý |
|---|---|
| Bí mật | Script tự sinh `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, mật khẩu Postgres. **Không dùng giá trị mẫu.** |
| DNS nội bộ | Khai báo `pm.apillis.lan` và `studio.apillis.lan` trỏ về IP server |
| HTTPS | Dùng chứng chỉ nội bộ của Caddy. Cài root CA một lần lên các máy (file `/data/caddy/pki/authorities/local/root.crt` trong volume `caddy_data`) |
| Studio | Chỉ máy có IP `ADMIN_IP` mở được |
| Cập nhật phiên bản | `deploy.sh v1.x.y`: tự backup trước, chạy migration, build lại web |
| Quay lại bản cũ | `deploy.sh <tag cũ>`. **Nếu đã chạy migration** thì phải thêm `restore.sh <file pre-deploy.dump>`, vì checkout tag cũ không hoàn tác được thay đổi cấu trúc DB |
| Backup | Cron chạy 23:30 hằng đêm, theo quy tắc 3-2-1: ổ server + NAS (`NAS_TARGET`) + cloud mã hoá (`RCLONE_REMOTE`, Chủ nhật). Ngày 1 hằng tháng phải restore thử vào DB test |

## 5. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| "Email này không được phép đăng ký" | Dùng email `@apillis.com`, hoặc thêm tên miền tại Cài đặt → Chung |
| Đăng nhập được nhưng menu trống | Tài khoản chưa có vai trò. Nhờ quản trị gán vai trò |
| "No exchange rate for USD…" | Nhập tỷ giá tại Cài đặt → Tiền tệ & tỷ giá, hoặc nhập tỷ giá ngay trên chứng từ |
| "Lines are locked…" | Chứng từ đã gửi duyệt. Bấm **Rút lại**, hoặc dùng ECO / phiên bản mới |
| "You cannot approve a document you submitted" | Nguyên tắc tách nhiệm vụ: người khác cùng vai trò phải duyệt |
| Không thấy giá trên PO | Đúng thiết kế với vai trò Kho / QA / Vận chuyển |
