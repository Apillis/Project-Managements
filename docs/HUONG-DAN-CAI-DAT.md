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
9. **BOM nhiều cấp từ file khách (v1.1):**
   - Tạo BOM nháp → bấm **Nhập Structure BOM** → chọn file Excel của khách (vd. AZTAKD610). Hệ thống tự tìm sheet và dòng tiêu đề, cột Level tạo cây cấp 1/2/3…, mã hàng khớp theo mã Ecount → MPN → mã khách, chưa có thì tạo mới; đơn giá trong file đưa vào **Bảng giá**.
   - Nếu khách đổi mẫu file: **Cài đặt → Ánh xạ cột khi nhập Excel**, thêm tên cột mới.
   - Nhập **Số bộ sản xuất** → cột **SL cần** = SL/cụm cha × số cụm cha × số bộ. Mục **Phân tích BOM** có tab *Gộp theo mã* và *Nhu cầu ròng* (trừ tồn kho, làm tròn MOQ).
   - **Danh mục hàng Ecount:** Nhập dữ liệu cũ → tab *Danh mục hàng Ecount* → tải file xuất từ Ecount; cập nhật theo Item Code, giá mua vào bảng giá.
10. **Dự toán giá (v1.1):** trong BOM bấm **Lập dự toán giá** → hệ thống lấy giá tốt nhất từ bảng giá, thêm nhân công mẫu và phí (forwarder, CoC…) → xem bảng **A–L** (B vật tư, C nhân công, E markup, K giá bán, L gồm phần dư MOQ) → **Cập nhật giá** khi có giá mới → Gửi duyệt → Ban Giám đốc duyệt → **Tạo báo giá**.
11. **Hỏi giá NCC – RFQ (v1.1):** trong BOM bấm **Tạo RFQ** (có thể chỉ các dòng chưa có giá), chọn NCC → **Gửi RFQ** (email tới người liên hệ nhận RFQ của NCC) → **Nhập báo giá** của từng NCC → bảng so sánh tô xanh giá / thời gian giao tốt nhất → **Chọn** (giá vào bảng giá) → **Tạo PO từ RFQ**.
12. **Phiếu yêu cầu vật tư – xuất kho theo phiếu (v1.2):**
    - Kỹ thuật / Sản xuất / PMO: menu **Kho → Phiếu yêu cầu vật tư** (hoặc tab **Vật tư** của dự án) → tạo phiếu, chọn công việc IDEF0, ngày cần, nơi giao → thêm dòng (có thể chọn dòng BOM đã duyệt) → **Gửi duyệt** → PM duyệt. Kho nhận thông báo.
    - Kho: **Kho → Xuất kho theo phiếu** → chọn vị trí, lấy từ *tồn của dự án* hoặc *kho chung* → **Xuất**. Không xuất vượt số lượng yêu cầu; phiếu tự chuyển "Đã xuất một phần / đã xuất".
    - Muốn bắt buộc mọi lần xuất kho phải có phiếu: bật `issue_requires_request` trong Cài đặt → Chung.
13. **Vận chuyển (v1.2):** menu **Vận chuyển → Chuyến hàng** (hoặc tab **Vận chuyển** của dự án) → nhập chiều (nhập / xuất / nội bộ), nơi đi – nơi đến, đơn vị vận tải, xe, tài xế, ngày đi / giao dự kiến, cước + chi phí khác → chuyển trạng thái *Đã đặt xe → Đang vận chuyển → Đã giao*. Cước được cộng vào chi phí dự án; báo cáo **Chi phí vận tải theo tuyến / dự án** ở Xuất Excel.
14. **Tài chính dự án (v1.2):**
    - Kế toán: **Tài chính → Mốc thanh toán** — lập lịch thanh toán theo hợp đồng, ví dụ *30% tạm ứng*, *60% sau FAT* (chọn công việc IDEF0 "FAT với khách hàng"), *10% sau SAT*. Tổng % của một SO không vượt 100%.
    - Khi công việc gắn với mốc hoàn thành, mốc chuyển **Sẵn sàng xuất hoá đơn** và Kế toán được báo. Bấm **Lập hoá đơn** → kiểm tra dòng → **Phát hành** (dòng bị khoá; điền *Số HĐĐT (MISA)*) → **Ghi nhận thu tiền** khi khách trả (thu một phần được, không thu vượt).
    - **Thu / chi tiền:** khoản chi cho NCC chọn theo PO (không vượt tổng PO), khoản chi cước chọn đơn vị vận tải + dự án.
    - **Tài chính → Tài chính dự án**: tab *Lãi / lỗ* (doanh thu SO, đã xuất HĐ, đã thu, công nợ, chi phí PO + giờ công + vận chuyển, biên lợi nhuận, dòng tiền ròng), *Dòng tiền* theo tháng (thực tế + dự kiến), *Công nợ phải thu* với tuổi nợ.
15. **Đóng dự án (v1.2):** tab **Tổng quan** của dự án → **Đóng dự án**. Hệ thống hiện checklist (công việc chưa xong, chứng từ chờ duyệt, PR/PO/phiếu vật tư còn mở, NCR, hồ sơ tuân thủ, chuyến hàng chưa giao, mốc chưa xuất HĐ, hoá đơn chưa thu đủ, giờ công chưa duyệt, tồn kho còn giữ cho dự án). Chỉ đóng được khi tất cả bằng 0. Sau khi đóng, **mọi chứng từ của dự án bị khoá** (trừ phiếu bảo hành); chỉ **Ban Giám đốc** mới mở lại được.
16. **Bản tin nhắc việc hằng ngày (v1.2):** khi dịch vụ notifier chạy, mỗi ngày sau `digest_hour` (mặc định 7 giờ) hệ thống gửi thông báo: việc quá hạn (cho người thực hiện), chứng từ chờ duyệt quá `approval_reminder_days` ngày, NCR quá hạn, PO trễ, hoá đơn quá hạn, mốc chờ xuất HĐ, phiếu vật tư cần xuất, vật tư dưới tồn tối thiểu, chuyến hàng trễ. Quản trị có nút **Gửi bản tin ngay** ở Cài đặt → Chung.
17. **Quên mật khẩu (v1.2):** ở màn hình đăng nhập bấm **Quên mật khẩu?** → nhập email → mở link trong email → đặt mật khẩu mới ở trang Hồ sơ.

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
| Đơn vị tính | Danh mục ĐVT (EA, M, KG…) và hệ số quy đổi |
| Dự toán giá | Quy tắc phí (forwarder theo kiện, CoC…) và mẫu công đoạn lắp ráp (điện / cơ / cáp) |
| Ánh xạ cột khi nhập Excel | Tên cột chấp nhận cho file Structure BOM và Ecount |
| Chung → `default_labor_rate`, `rfq_email_enabled` | Đơn giá giờ mặc định cho dự toán; bật/tắt gửi email RFQ |
| Chung → `issue_requires_request` | Bắt buộc xuất kho theo phiếu yêu cầu vật tư đã duyệt (mặc định tắt) |
| Chung → `default_payment_days` | Hạn thanh toán mặc định của hoá đơn (ngày, mặc định 30) |
| Chung → `project_close_strict` | Chỉ cho đóng dự án khi checklist bằng 0 (mặc định bật) |
| Chung → `digest_enabled`, `digest_hour`, `timezone`, `approval_reminder_days` | Bản tin nhắc việc hằng ngày |
| Ma trận phân quyền (v1.2) | Phân hệ mới: *Phiếu yêu cầu vật tư*, *Vận chuyển & cước phí*, *Mốc thanh toán & hoá đơn*, *Thu / chi tiền* (mặc định: Kế toán ghi hoá đơn & thu chi; PMO xem) |

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
curl -fsSL https://raw.githubusercontent.com/Apillis/Project-Managements/main/deploy/scripts/install-server.sh | bash -s -- v1.2.0
nano /opt/apillis-pm/supabase/.env      # SITE_URL, API_EXTERNAL_URL, SUPABASE_PUBLIC_URL = https://pm.apillis.lan, SMTP, ADMIN_IP
/opt/apillis-pm/pm-app/deploy/scripts/deploy.sh v1.2.0
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
| "Project … is closed — its records are locked" | Dự án đã đóng / huỷ. Ban Giám đốc mở lại dự án nếu thật sự cần sửa |
| "The project cannot be closed yet: …" | Xử lý các mục còn mở trong checklist đóng dự án (danh sách in trong thông báo lỗi) |
| "Over-issue …" / "Over-payment …" | Xuất vượt phiếu yêu cầu, hoặc thu / chi vượt hoá đơn / PO — kiểm tra lại số lượng / số tiền |
| Không nhận bản tin nhắc việc | Kiểm tra dịch vụ notifier đang chạy, `digest_enabled` = true và giờ hiện tại đã qua `digest_hour` |
