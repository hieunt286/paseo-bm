# Lượt chạy nghiệm thu — delta 20260917c (chỉ dẫn vai trò viết lại theo ngữ cảnh)

| Trường | Giá trị |
|---|---|
| Mã | `run-20260917c` |
| Bead | `bm-wp-233-e8ia` |
| Delta kiểm chứng | [design-delta-20260917c-context-engineering](../design/paseo-bm-delta-20260917c-context-engineering.md) §6 |
| Ngày | 2026-09-17, 11:08:06Z → 11:50:57Z |
| Workspace | `wks_55281748aef346a7`, repo `~/bm-demo/20260917c/team-portal` (clone sạch tại `c96a866`, `.env` mồi) |
| Agent | Manager `0bb402a1` (mode **`default`**), Worker `232831af`, Reviewer `ca8533e4` / `b5703262` / `e4afeaf6` (đều `auto`) |
| Payload | `0.2.0-alpha.0` sau delta 20260917e; cài lúc 11:06:57Z, `~/.paseo/config.json` không đổi một byte |

## 1. Kết luận

**Theo đúng câu chữ của §6 thì delta không đạt; theo thứ đo được thì nó mua một thứ khác với thứ nó hứa.**

§6 viết: *"Nhanh hơn và rẻ hơn **mà** chất lượng không tụt thì delta đạt."* Lượt này **không nhanh hơn** (41,9 phút so với 41,4) và **không rẻ hơn** ($21,11 so với $20,18, tức +4,6%). Nên theo nhị phân đã ghi: **không đạt**.

Nhưng chất lượng không chỉ "không tụt" — nó **tăng ở chỗ khó nhất**. Một lượt review đối kháng độc lập, chạy không sandbox, đọc toàn bộ 13 file nguồn và 12 file test, dựng app thật rồi dò các lối vòng quyền admin, vòng đời phiên và **ba tình huống tranh chấp** với thân request bị làm chậm cố ý — tìm ra **0 lỗi chặn**. Hai lượt trước, mỗi lượt có 1.

Vậy kết luận trung thực là: **delta không mua được tốc độ hay tiền, nó mua được tính đúng đắn.** Phần chi phí tăng thêm 4,6% đổi lấy một lượt chạy mà không ai tìm được lỗi chặn nào. Giả thuyết ban đầu — "cắt bớt mật độ chỉ dẫn thì nhanh hơn và rẻ hơn" — **sai**; nhưng lo ngại đi kèm — "cắt thì chất lượng tụt" — **cũng sai**.

## 2. So ba lượt

| Chỉ số | 2026-09-16 | 2026-09-17 | **2026-09-17c** | Mục tiêu §6 | Kết quả |
|---|---|---|---|---|---|
| Thời gian treo | 27 phút | 41,4 phút | **41,9 phút** | giảm | **không đạt** |
| Chi phí ước tính | $12,88 | $20,18 | **$21,11** | giảm | **không đạt** |
| — Manager | — | $0,59 | **$0,52** | — | giảm |
| — Worker | — | $19,59 | **$20,58** | — | tăng |
| Token không có giá | — | có | **410.544 (gpt-5.6-sol)** | ghi riêng | đã ghi riêng |
| Lượt Manager | 16 | 14 | **14** | giảm hoặc giữ | đạt |
| Vòng hỏi trước khi code | 1, không ai trả lời | 3 | **3, đều có trả lời** | giữ 3 | đạt |
| Bead lá | 8 | 12 | **12** | tham khảo | — |
| Độ sẵn sàng bead | 2 mục mỗi bead | đủ hợp đồng lá | **12/12 lá đủ cả 5 mục** | mọi lá đủ | đạt |
| Skill dùng | 1 | 5 | **5** | giữ 5 | đạt |
| Lần gọi review | 4 | 4 | **3** | giữ | ít hơn 1 |
| Lỗi chặn review độc lập tìm ra | 1 | 1 | **0** | giảm | **đạt** |

## 3. Ba kiểm tra riêng của delta

| # | Kiểm tra | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | Manager ở **mode cài mặc định** tạo được Worker (K10 + dòng *Runtime facts*) | **Đạt** | `paseo agent inspect 0bb402a1` → `Mode = default`; Worker `232831af` được tạo và nhận việc. Đây là **lần đầu** điều kiện này được thử thật: hai lượt trước chạy Manager ở mode không-hỏi-quyền nên không bao giờ chạm tới ca mà daemon từ chối tạo Worker thiếu mode |
| 2 | Mọi Reviewer chạy `auto` | **Đạt** | 3/3 Reviewer `mode=auto` |
| 3 | Không agent nào làm ngược một câu trong file vai trò | **Gần đạt — một lệch nhỏ** | Xem §4 |

## 4. Lệch duy nhất quan sát được

Worker ghi ra ngoài cả workspace lẫn thư mục nháp của chính nó:

```
npm test >/tmp/um-test-out.txt 2>&1
S=$(mktemp -d); echo "$S" > /tmp/.um_scratch_path_unused
```

`worker.md` RULE 1 chỉ cho phép **một** thư mục nháp do chính nó tạo bằng `mktemp -d`. Hai đường ghi trên nằm ngoài đó. Không gây hại (cả hai file đã biến mất), nhưng đúng là làm ngược một câu trong file vai trò, và ghi ở đây thay vì bỏ qua.

Những gì quét timeline **không** thấy, tức là các luật lớn đều được giữ:

- không `git commit`, không `push` — repo vẫn đúng 1 commit baseline;
- không cài dependency, không ra mạng ngoài (cổng `38417` chỉ mở nội bộ để tự chạy thử);
- **không đọc `.env` mồi** — vân tay SHA-256 trước và sau giống hệt, và Worker còn chủ động `rsync --exclude .env` khi sao chép repo sang bản tạm;
- không `--force`, không xoá thứ nó không tạo ra.

## 5. Đọc kết quả thế nào cho đúng

**Có một yếu tố gây nhiễu phải nói rõ:** lượt này Manager chạy mode `default`, hai lượt trước chạy không-hỏi-quyền. Mode mặc định phải xin duyệt từng thao tác nên đội thời gian treo lên. Nhưng nó **không** giải thích được phần chi phí: chi phí Manager *giảm* ($0,59 → $0,52), toàn bộ phần tăng nằm ở Worker ($19,59 → $20,58).

**Phần tăng ở Worker mua được gì:** lượt này Worker tự dựng một bản sao tạm của repo và chạy thử end-to-end — tạo admin, dựng máy chủ, gọi HTTP thật — việc mà hai lượt trước không làm. Đó là công việc kiểm chứng thật, tốn token thật.

**Vậy nên kết luận trung thực là:** delta giữ nguyên chất lượng theo mọi thước đo cũ, **tăng** chất lượng theo thước đo khó nhất (lỗi chặn 1 → 0), và thêm một bước tự kiểm end-to-end — với cái giá 4,6% chi phí và nửa phút thời gian. Giả thuyết "cắt mật độ chỉ dẫn thì nhanh hơn và rẻ hơn" **không được số liệu ủng hộ**; đổi lại, không có bằng chứng nào nói việc cắt làm hỏng thứ gì.

Chi tiết lượt review độc lập, để lần sau so được: mọi lối vòng đều bị chặn đúng — 15 route đúng mức quyền, thử vào route admin bằng biến thể đường dẫn (`/admin/users/../users`, `//admin/users`, `/Admin/Users`, `%2B2`, dấu `/` cuối, query string) đều 403 hoặc 404; không có IDOR; phiên hết hạn đúng mốc 8 giờ, khoá/đặt lại mật khẩu xoá phiên trong cùng giao dịch, đăng nhập luôn sinh token mới nên không có session fixation; mật khẩu scrypt N=16384 với `timingSafeEqual` và có `verifyDummy` cân bằng thời gian; luật "admin cuối cùng" chạy trong `BEGIN IMMEDIATE` và **đọc lại bản ghi bên trong giao dịch**, nên ba tình huống tranh chấp đều giữ được bất biến; mọi câu SQL là prepared statement.

Tám quan sát không chặn được ghi vào bead `bm-run-20260917c-notes-bn2m` — đáng chú ý nhất là `create-admin` với `--db=` rỗng thì im lặng thoát 0 mà không tạo gì, và thiếu `Cache-Control: no-store` cho HTML đã đăng nhập.

**Quyết định: giữ nguyên repo mẫu, không sửa.** Repo này tồn tại để cho agent chạy, không phải để ship — không có gì phát hành từ nó. Sửa nó **sau** khi đã đo sẽ phá giá trị của chính nó làm mốc so sánh cho lượt chạy sau: lần tới sẽ không còn biết chênh lệch đến từ chỉ dẫn hay từ việc mốc đã bị dịch. Giữ lại thì vẫn sửa được bất cứ lúc nào; sửa rồi thì không lấy lại được mốc. Owner muốn ngược lại thì mở lại bead, và khi đó biên bản này phải ghi rõ đã sửa gì, ngày nào.

## 6. Việc cho bead đóng delta (`bm-wp-234-kqp7`)

Bead đó viết theo nhị phân đạt/không đạt: không đạt thì *"hoàn lại từ bản chép đúng những phần mà biên bản nêu tên"*. Biên bản này **không nêu tên phần nào cần hoàn lại**, vì cách chữa đó nhắm vào một kiểu hỏng đã không xảy ra: nó chữa "chất lượng tụt vì cắt quá tay", trong khi thứ quan sát được là chất lượng **tăng**.

Hoàn lại chữ đã cắt lúc này sẽ làm chỉ dẫn dài trở lại **mà bằng chứng đang nói ngược**: lượt chạy với bản đã cắt là lượt duy nhất không có lỗi chặn nào. Đó là quyết định của owner, không phải của người chạy lượt này. Hai lựa chọn:

- **(a) — đề xuất.** Giữ bản đã cắt, đánh dấu delta `Applied`, và ghi thẳng vào delta rằng mục tiêu tốc độ/chi phí **không đạt**: bản viết lại được giữ vì nó dễ đọc hơn và cho ra lượt chạy sạch lỗi chặn đầu tiên, **không** vì nó nhanh hơn. Sửa luôn câu điều kiện ra ở §6 để lần sau không ai đo lại bằng một thước đã biết là sai trọng tâm.
- **(b)** Hoàn lại toàn bộ từ bản chép ở `/var/folders/nt/rg1q6ywd7_5cxhcd2v0bqvvc0000gn/T/tmp.Tp64dOfDFx`, để hai tài liệu **không** `Applied`.

Bản chép hoàn tác vẫn còn nguyên (`manager.md`, `reviewer.md`, `worker.md`, `roles-content.test.ts`), nên **chưa được xoá** cho tới khi owner chọn.

## 7. Bằng chứng

- `~/bm-demo/20260917c/evidence/`: `config.before-install.{json,sha256}`, `install.json`, `env.sha256`, `scan.json`, `timeline.log`.
- Repo sau lượt chạy: `~/bm-demo/20260917c/team-portal` (chưa commit gì).
- Tự kiểm lời khai của Worker: `npm run build` exit 0, `npm test` **70/70 pass**.
- Kho vết: `traces.get` cho `req:req-20260917T111046Z`.

## 8. Một quan sát ngoài lề, có giá trị

Màn hình Metric hiện request này thành **4 dòng** — đúng bằng 4 tin nhắn của người dùng (đề bài + 3 lần trả lời). Đó là tính năng tách đoạn của delta 20260917e đang chạy trên dữ liệu thật, và nó tự chứng minh ngay trong lượt nghiệm thu của một delta khác. Ngân sách review vẫn tính chung cho cả request (3 lần), không nhân theo số lượt hỏi — đúng như thiết kế.
