# Delta-change — README ngắn, tài liệu tham chiếu chuyển sang GUIDE.md

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918b-short-readme` |
| Tài liệu gốc | [paseo-bm PRD](../../product/paseo-bm-prd.md) (Accepted 2026-09-15), [ADR-003](../../adr/ADR-003-skills-delegation.md) (Accepted) |
| Status | Merged — gộp vào [paseo-bm-prd.md](../../product/paseo-bm-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Accepted | 2026-09-18 — owner hieu.nt10, trả lời trong chat với Beads Worker |
| Applied | 2026-09-18 |
| Bead | `bm-readme-simplify-pjmh` (README ngắn, đã đóng), `bm-readme-guide-um2s` (GUIDE.md), `bm-readme-publish-vnod` (commit và push) |
| Nguồn | Request `req-20260918T011334Z`: "cập nhật readme lại cho đơn giản, đưa ảnh flow và mô tả sơ bộ thôi, sau đó là link https://paseo-bm.erai.pro". Trả lời tiếp theo của owner: "làm theo gợi ý", "1a 2 có commit và push" |

## 1. Tóm tắt

Owner muốn `README.md` đơn giản: ảnh luồng, mô tả sơ bộ, rồi link tới site giới thiệu https://paseo-bm.erai.pro. README mới còn khoảng 40 dòng: ảnh luồng `assets/paseo-bm-flow.svg`, mô tả ba vai trò và các màn hình, bắt đầu nhanh bằng `npx paseo-bm`, ba cảnh báo tin cậy tóm tắt, link site.

Site **không** chứa phần tham chiếu của README cũ (xem §2), nên owner chọn chuyển **nguyên văn** các mục tham chiếu đó sang một file mới `GUIDE.md` ở gốc repo, và README trỏ tới nó. Quyết định này trái chữ của REQ-015 và REQ-013(d) (README phải tự chứa các mục đó) và của ADR-003 quyết định 9, nên cần delta này.

## 2. Vì sao

- Owner muốn trang đầu của repo và của npm ngắn, dẫn người đọc sang site để xem giới thiệu có hình.
- Kiểm tra site ngày 2026-09-18 (chỉ đọc, owner cho phép; trang chủ và 9 trang mục, tất cả HTTP 200):

  | Nội dung | Có trên site |
  |---|---|
  | Cảnh báo tin cậy (plugin không sandbox, công cụ agent cho mọi agent, Worker không hỏi quyền) | Có — trang Safety |
  | Nguồn skills là repo của tác giả khác | Có — trang Tools |
  | CLI `skills` có kênh thu thập dữ liệu riêng | Có — trang Safety |
  | Hội thoại được ghi trên máy, chỉ macOS/Linux | Có — trang Safety |
  | Yêu cầu hệ thống đầy đủ | Không — site ghi "Requirements and versions are listed in the README" |
  | Bảng mọi vị trí paseo-bm ghi vào | Không |
  | Bảng mã thoát, JSON | Không |
  | Xử lý sự cố | Không |
  | Cập nhật, gỡ cài đặt, gỡ skills bằng công cụ của nó | Không |
  | Lệnh `skills add` cài tay, `doctor`, cài không tương tác, bảng lệnh và cờ | Không |

  Mọi link của site về README đều ghim commit `4d17d14`, nên vẫn mở được nhưng dẫn tới bản README cũ.
- `GUIDE.md` đặt ở gốc repo, không đặt trong `docs/`, vì `docs/` chỉ dành cho tài liệu tiếng Việt (quy tắc ngôn ngữ trong `AGENTS.md`), còn tài liệu cho người dùng npm và GitHub viết bằng tiếng Anh như README.

## 3. Rủi ro phải chấp nhận có ý thức

- **Trang npm chỉ có README.** `package.json` `files` là `dist/` và `plugin/`, nên `GUIDE.md` và ảnh luồng không nằm trong gói; README trỏ tới chúng bằng đường dẫn tương đối, mở được trên GitHub. Người đọc trên npm cần thêm một lần bấm để tới phần tham chiếu, và việc npm có phân giải đường dẫn tương đối về GitHub hay không chưa được kiểm chứng.
- **README mới chỉ lên npm ở bản phát hành kế tiếp**, vì trang npm hiển thị README của phiên bản đã publish.
- **Cảnh báo đầy đủ không còn nằm trên trang đầu.** README giữ ba cảnh báo tóm tắt; bản đầy đủ (gồm việc ghi hội thoại vào `~/.paseo-bm/traces/`, chế độ quyền của Manager và Reviewer) nằm ở `GUIDE.md` và trang Safety của site. Trình cài vẫn in đủ cảnh báo khi hỏi đồng ý.
- **Hai nguồn có thể lệch nhau.** Site trích README cũ ở commit `4d17d14`; `GUIDE.md` là nguồn tham chiếu từ nay. Cập nhật site nằm ngoài repo này.

## 4. Ảnh hưởng — các dòng đã đổi

| # | Tài liệu và vị trí | Trước | Sau |
|---|---|---|---|
| 1 | `docs/product/paseo-bm-prd.md`, REQ-013 ý (d) | `(d) Bảng mã thoát nhất quán giữa các lệnh và được ghi trong README.` | Giữ câu, thêm errata: bảng mã thoát nay nằm trong `GUIDE.md`, README trỏ tới |
| 2 | `docs/product/paseo-bm-prd.md`, REQ-015 | `README có đủ: …` | Giữ câu, thêm errata: README ngắn (ảnh luồng, mô tả sơ bộ, lệnh cài một dòng, cảnh báo tin cậy tóm tắt, ghi nhận nguồn skills, link site và `GUIDE.md`); mọi mục còn lại của REQ-015 nằm trong `GUIDE.md` |
| 3 | `docs/product/paseo-bm-prd.md`, Revision History | — | Thêm dòng 2026-09-18 trỏ về delta này |
| 4 | `docs/adr/ADR-003-skills-delegation.md`, quyết định 9 | `README nêu rõ nguồn skills là repo của tác giả khác, …` | Giữ câu, thêm ghi chú bổ sung 2026-09-18: README nêu nguồn skills là repo của tác giả khác; lưu ý về CLI `skills` bên thứ ba và việc cài kiểu symlink nằm trong `GUIDE.md` |

## 5. Quy ước đọc cho các chỗ không sửa tại chỗ

Từ 2026-09-18, khi PRD, Technical Design hay ADR nói "README" theo nghĩa **tài liệu tham chiếu cho người dùng**, hiểu là `README.md` cùng `GUIDE.md`. Các chỗ này không sửa từng dòng:

- PRD: journey "đọc README và gõ `npx paseo-bm`"; NFR "chỉ tự ghi vào các vị trí được liệt kê trong README"; tiêu chí Phase 1 "README đạt REQ-015".
- ADR-001 (hệ quả: thông điệp rõ ràng trong `doctor` và README); ADR-003 (hệ quả: nêu việc cài kiểu symlink trong README).
- Technical Design `docs/design/paseo-bm.md` §7 ("README phải nói rõ" về CLI `skills`).

Các biên bản và checklist trong `docs/operations/` là hồ sơ lịch sử, đối chiếu với README tại thời điểm đó, nên giữ nguyên.

## 6. Những gì KHÔNG đổi

- Nội dung tham chiếu: `GUIDE.md` chép nguyên văn các mục "Before you install" tới "Known limits" của README tại commit `4d17d14`, không thêm hay bớt ý.
- Hợp đồng công khai của CLI: tên lệnh, cờ, mã thoát, mã lỗi và hình dạng `--json`.
- Mọi yêu cầu nội dung của REQ-015 vẫn giữ; chỉ đổi file chứa chúng.

## 7. Duyệt

- [x] README ngắn theo bốn đề xuất của Worker: không sửa PRD trong lượt đầu, giữ ba cảnh báo tóm tắt, ảnh luồng SVG tự vẽ, chỉ link trang chủ của site (bead `bm-readme-simplify-pjmh`)
- [x] "Làm theo gợi ý": cập nhật REQ-015, REQ-013(d) và ADR-003; kiểm tra site (chỉ đọc)
- [x] Chọn 1a: phần tham chiếu chuyển nguyên văn sang `GUIDE.md` ở gốc repo; commit và push các file của request này
- Approved-by: hieu.nt10 (trả lời trong chat với Beads Worker, request `req-20260918T011334Z`), ngày 2026-09-18

## 8. Việc thực hiện

| Mã | Việc | Bead | Người làm |
|---|---|---|---|
| T1 | README ngắn: ảnh luồng `assets/paseo-bm-flow.svg`, mô tả sơ bộ, bắt đầu nhanh, ba cảnh báo tóm tắt, link site | `bm-readme-simplify-pjmh` | Beads Worker |
| T2 | `GUIDE.md` ở gốc repo chép nguyên văn dòng 63–609 của README tại `4d17d14`; README trỏ tới `GUIDE.md` | `bm-readme-guide-um2s` | Beads Worker |
| T3 | Một commit trên `main` chỉ gồm các file của request này, rồi `git push origin main`; không đụng các thay đổi chưa commit của việc khác, không publish npm | `bm-readme-publish-vnod` | Beads Worker, được owner cho phép rõ ràng ngày 2026-09-18 ("1a 2 có commit và push") |

**Ngoại lệ nhãn.** Ba bead trên mang `feature:paseo-bm`, `feature:readme` và `phase:2a-5`, **không có `wp:*`**, vì request này không thuộc work package nào của plan. Đây là ngoại lệ với quy ước nhãn trong `AGENTS.md`, owner duyệt ngày 2026-09-18 (trả lời "1.a" sau review lô `b2`), theo tiền lệ `bm-settings-rpc-stgv` và `bm-run-20260917c-notes-bn2m`.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Claude) | Tạo, owner duyệt và áp dụng vào PRD REQ-013d, REQ-015, Revision History và ADR-003 quyết định 9 |
| 2026-09-18 | hieu.nt10 (soạn bởi Claude) | Thêm §8 Việc thực hiện (T1–T3) sau review lô `b2` |
| 2026-09-18 | hieu.nt10 (soạn bởi Claude) | §8: ghi ngoại lệ nhãn không có `wp:*`, owner duyệt sau lượt review lại của lô `b2` |
