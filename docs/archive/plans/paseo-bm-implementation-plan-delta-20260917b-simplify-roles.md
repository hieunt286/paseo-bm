# Delta plan — Ba file vai trò: ít luật cấm hơn, luồng làm việc rõ hơn

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260917b-simplify-roles` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-222 → WP-226 vào Phase 2a-3 |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Applied** — sáu bead đóng ngày 2026-09-17 |
| Plan-ready | **PASS — 2026-09-17 — hieu.nt10** (cổng `plan-ready-for-beads` do Claude tự chấm sau một lượt `reviewing-plan`; lần chấm đầu FAIL 4 mục, đã bổ sung — xem §6) |
| Owner | hieu.nt10 |
| Created | 2026-09-17 |
| Source design | [design-delta-20260917b-simplify-roles](../design/paseo-bm-delta-20260917b-simplify-roles.md) (Accepted) — nguồn duy nhất cho mọi giới hạn cứng, bảng chuyển §4.3 và danh sách bỏ §4.4 |
| Source PRD | [PRD](../../product/paseo-bm-prd.md) **REQ-032** (bộ chỉ dẫn vai trò — yêu cầu chính), REQ-020(d), REQ-022, REQ-024, REQ-026, REQ-034, REQ-036, REQ-037 |
| Routing decision | Brownfield, rủi ro **trung bình–cao**: viết lại chỉ dẫn hệ thống của ba agent chạy không có lời nhắc xin phép. Không đổi hợp đồng máy đọc, không đổi mã. Đi chuỗi: delta thiết kế → delta plan → `reviewing-plan` → cổng `plan-ready-for-beads` → `converting-plan-to-beads` → `polishing-beads` → `implementing-beads` |
| Phase | Phase 2a-3 (nhãn bead `phase:2a-3`) |

## 1. MVP-Lock

- **Trong phạm vi:** toàn bộ §4 của delta thiết kế, cộng các cập nhật tài liệu ở §7 của nó.
- **Ngoài phạm vi:**
  - mọi thay đổi **nội dung** quyết định (mức, ngân sách review, mốc hỏi, mốc báo cáo, hợp đồng leaf bead, tiêu chí Reviewer);
  - mọi thay đổi mã server/client, Dashboard, `workflowStepSchema`;
  - NEW-1 (Reviewer không chạy được test HTTP dưới sandbox `auto`) — chờ owner quyết, không thuộc delta này;
  - cài lại payload lên daemon của owner (việc riêng, xin phép riêng);
  - phát hành npm.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Ba file vai trò ≤ 240 dòng; ngân sách cấm đoán đạt trần mới.
  3. Bảng §4.3 của delta thiết kế đối chiếu đủ: không luật nào mất chỗ đến.
  4. Mỗi bead đổi nội dung có một đối chứng âm chứng minh test bắt được khi giới hạn bị xoá.
  5. Một lô review tài liệu (`documents`) và một lô review mã (`implementation`) đạt.
- **Tư thế hoàn tác mặc định:** repo này không commit khi chưa được yêu cầu, nên `git` **không** phải đường hoàn tác: ba file vai trò đang ở trạng thái đã sửa nhưng chưa commit, `git checkout` sẽ nuốt luôn công của bảy delta trước. Đường hoàn tác được duyệt cho pha này: **WP-222** chép ba file `plugin/roles/*.md` cộng `test/roles-content.test.ts` vào một thư mục `mktemp -d` và giữ tới khi WP-226 đóng; hoàn tác một WP = chép ngược file tương ứng rồi chạy lại `npm run generate:role-instructions`. Không có điểm nào không đảo ngược được.

## 2. Work packages

### WP-222 — Viết lại `test/roles-content.test.ts` theo hành vi

- **Phủ yêu cầu / design refs:** REQ-032(b)(d) (chỉ dẫn nêu đủ trách nhiệm, ranh giới, quy trình, lúc phải hỏi — và người dùng đọc được) · delta thiết kế §4.6.
- **Kết quả:** một bộ test hai tầng (ghim nguyên văn hợp đồng máy đọc; khẳng định theo ý cho mỗi giới hạn cứng) **xanh với ba file hiện tại chưa sửa**.
- **Vì sao đi trước:** nếu viết lại file vai trò trước, mọi khẳng định theo câu chữ sẽ đỏ hàng loạt và không còn cách nào phân biệt "đỏ vì mất hành vi" với "đỏ vì đổi chữ". Bộ test xanh cả trước lẫn sau khi viết lại chính là bằng chứng rằng nó bám hành vi chứ không bám câu chữ.
- **Phạm vi:** `test/roles-content.test.ts`. Giữ nguyên trần dòng cũ (280/240/240) và **chưa** thêm ngân sách cấm đoán — hai thứ đó chỉ đúng sau khi ba file được viết lại (WP-226).
- **Ràng buộc quyết định cách viết test:** khẳng định theo ý kiểm trên **toàn file**, không kiểm trong phạm vi một mục. Lý do: §4.3 của delta thiết kế chuyển rất nhiều câu từ `## RULES` sang các bước; một khẳng định gắn với mục sẽ đỏ chỉ vì nội dung dời chỗ, đúng thứ bộ test này sinh ra để tránh. Helper `section()` chỉ còn dùng cho các khối máy đọc và cho khẳng định về **thứ tự** bên trong một mục.
- **Điều kiện ra:** `npx vitest run test/roles-content.test.ts` xanh, không sửa một byte nào trong `plugin/roles/`.
- **Đối chứng âm:** xoá tạm một giới hạn cứng khỏi bản sao của một file vai trò trong thư mục `mktemp -d` → khẳng định tương ứng đỏ.

### WP-223 — Viết lại `worker.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-026(a)(d) (ranh giới an toàn phải còn nguyên hiệu lực sau khi gộp) · delta thiết kế §4.2 (W1–W5), §4.3 (bảng worker), §4.4, §4.5.
- **Kết quả:** `worker.md` theo bố cục §4.5, RULES còn 5 giới hạn cứng (§4.2), mục "Thứ tự bạn làm" tách riêng, mọi luật khác chuyển đúng chỗ theo §4.3, sáu điểm §4.4 bỏ hẳn.
- **Phạm vi:** `plugin/roles/worker.md`, `plugin/server/worker-instructions.ts` (sinh lại), điều chỉnh khẳng định trong `test/roles-content.test.ts` nếu một neo theo ý không còn khớp.
- **Ràng buộc:** ≤ 240 dòng; `## RULES` vẫn là heading đầu; không đổi khối `BM-REPORT`, bảng mức, ngân sách, mốc hỏi, hợp đồng leaf bead.
- **Điều kiện ra:** lý do đóng bead đi hết **từng dòng** bảng §4.3 (phần worker) và nói rõ mỗi luật nay nằm ở đâu; `npx vitest run test/roles-content.test.ts` và `test/plugin-bundle-cjs.test.ts` xanh.
- **Phụ thuộc:** WP-222.

### WP-224 — Viết lại `reviewer.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-024(e) (Reviewer chỉ đọc, không tạo agent) · delta thiết kế §4.2 (R1–R4), §4.3 (bảng reviewer), §4.5.
- **Kết quả:** RULES còn 4 giới hạn cứng; phần "Bạn được chạy gì" giữ nguyên nội dung ở thể khẳng định; bảng tiêu chí theo giai đoạn, danh sách lô nhạy cảm và mục "Chặn hay không chặn" giữ nguyên nội dung.
- **Phạm vi:** `plugin/roles/reviewer.md` + file sinh lại + test tương ứng.
- **Ràng buộc:** ≤ 240 dòng; khối `BM-REVIEW` và `BM-REVIEW STOPPED` không đổi một ký tự.
- **Điều kiện ra:** như WP-223, cho phần reviewer của §4.3.
- **Phụ thuộc:** WP-222.

### WP-225 — Viết lại `manager.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-020(d), REQ-026(c)(f) (Manager không duyệt quyền, không xoá agent, được dừng) · delta thiết kế §4.2 (M1–M5), §4.3 (bảng manager), §4.5.
- **Kết quả:** RULES còn 5 giới hạn cứng; phần "Cách bạn nói" gom văn phong; sáu bước xử lý yêu cầu giữ nguyên nội dung.
- **Phạm vi:** `plugin/roles/manager.md` + file sinh lại + test tương ứng.
- **Ràng buộc:** ≤ 240 dòng; giữ nguyên `Continue <requestId>.`, cách tạo agent, bảng ngân sách, luật giám sát `skillsUsed`.
- **Điều kiện ra:** như WP-223, cho phần manager của §4.3.
- **Phụ thuộc:** WP-222.

### WP-226 — Siết trần, ngân sách cấm đoán, tài liệu

- **Phủ yêu cầu / design refs:** REQ-032(c) (cập nhật paseo-bm thì chỉ dẫn đi theo) · delta thiết kế §4.6, §7.
- **Kết quả:** trần dòng cả ba file xuống 240; thêm test ngân sách cấm đoán; cập nhật tài liệu theo §7 của delta thiết kế; delta và plan chuyển `Applied`.
- **Cách chốt con số ngân sách cấm đoán:** §4.6 của delta thiết kế đề xuất 22/12/14 **trước khi** bản viết lại tồn tại. Đo lại sau WP-225, lấy trần = số đo + 2, và ghi cả số đo lẫn trần vào §4.6. Không được sửa câu chữ file vai trò chỉ để chạm một con số đặt trước — đó chính là kiểu ép test mà W4 cấm.
- **Phạm vi:** `test/roles-content.test.ts`, `docs/design/paseo-bm.md` (errata §2.6), `docs/archive/design/paseo-bm-delta-20260917-workflow-skills.md` (một dòng đầu), `README.md` nếu có trích luật theo câu chữ, `docs/archive/operations/paseo-bm-workflow-skills-run-20260917.md` (mục mới), delta + plan này.
- **Điều kiện ra:** `npm run verify` mã 0, đọc từ mã thoát; ba file ≤ 240 dòng.
- **Phụ thuộc:** WP-223, WP-224, WP-225.

## 3. Thứ tự và lô review

```
WP-222 ──┬── WP-223 ──┐
         ├── WP-224 ──┼── WP-226
         └── WP-225 ──┘
```

Một yêu cầu mức **Vừa** theo bảng của chính sản phẩm (không đổi hợp đồng công khai, không đổi schema, một thành phần: thư mục `plugin/roles` cộng test của nó). Hai lô review:

- `b1` (documents): delta thiết kế + plan này + bead — kiểm bảng §4.3 và §4.4 đủ chỗ đến.
- `b2` (implementation): ba file vai trò viết lại + test + tài liệu.

## 4. Ranh giới rủi ro

- **Không** đổi bất kỳ con số, tên trường, tên nhãn, tên phase, tên mode nào.
- **Không** bỏ luật nào ngoài sáu điểm §4.4; mọi thứ khác phải tìm được ở chỗ mới.
- **Ngôn ngữ:** mọi chữ trong `plugin/roles/*.md` là **tiếng Anh** (luật ngôn ngữ của repo). Tên mục trong bảng §4.5 của delta thiết kế là mô tả tiếng Việt cho người đọc, không phải bản dịch cần chép vào file.
- Mỗi bead viết lại một file vai trò phải chạy `npm run generate:role-instructions` trước khi đóng, nếu không `test/plugin-bundle-cjs.test.ts` đỏ.
- Ba WP viết lại file đều đụng `test/roles-content.test.ts`. Làm **tuần tự**, không dùng sub-agent song song (luật của chính sản phẩm), để không có hai bead cùng sửa một file.
- Agent đang tồn tại giữ chỉ dẫn cũ; delta này không tự cài lại payload lên daemon.

## 5. Chiến lược kiểm thử

Theo quy ước của repo: Vitest, chạy trên file thật trong `plugin/roles/`, không mock.

| Tầng | Chạy gì | Bắt lỗi gì |
|---|---|---|
| Hành vi | `test/roles-content.test.ts` — mỗi giới hạn cứng một khẳng định theo ý, kiểm trên toàn file | Một giới hạn bị **xoá** khi gộp hoặc khi viết lại |
| Hợp đồng máy đọc | cùng file — ghim nguyên văn khối `BM-REPORT`, `BM-REVIEW`, `BM-REVIEW STOPPED`, tên nhãn, con số ngân sách | Đổi một ký tự trong thứ mà collector, `parseReport` hay Dashboard đọc |
| Đồng bộ payload | `test/plugin-bundle-cjs.test.ts` | Quên `npm run generate:role-instructions` sau khi sửa markdown |
| Cấu trúc | cùng `roles-content` — trần dòng, `## RULES` đứng đầu, ngân sách cấm đoán | File phình lại, hoặc lệnh cấm mọc thêm ở delta sau |
| Toàn bộ | `npm run verify` (typecheck × 2, lint, 1846 test, build) | Hồi quy ở nơi khác |

**Đối chứng âm là bắt buộc, không phải tuỳ chọn.** Mỗi bead sửa nội dung phải chứng minh test của nó đỏ khi hành vi bị lấy đi: chép file vai trò sang một thư mục `mktemp -d`, xoá một giới hạn cứng, trỏ test vào bản sao đó, thấy đỏ, rồi xoá thư mục. Không có đối chứng âm thì khẳng định "test bảo vệ hành vi này" chỉ là lời nói.

Không đặt mục tiêu độ phủ dòng: phạm vi delta là file Markdown, độ phủ không có nghĩa.

## 6. Kết quả cổng `plan-ready-for-beads`

Chấm ngày 2026-09-17, sau một lượt `reviewing-plan`.

```
Lần 1 — FAIL (4 mục bắt buộc)
  ✗ Plan-ready evidence ghi "chưa chạy cổng" thay vì Pending/PASS
  ✗ Thiếu tư thế hoàn tác mặc định của pha
  ✗ WP-222..WP-226 không có độ phủ REQ và design refs riêng
  ✗ Thiếu mục chiến lược kiểm thử

Lần 2 — PASS
  ✓ MVP-lock: phạm vi = §4 delta thiết kế; 5 điều kiện ra; ngoài phạm vi liệt kê 5 mục
  ✓ 5 work package, mỗi WP có kết quả, độ phủ REQ, design refs, ràng buộc, điều kiện ra, phụ thuộc
  ✓ Phụ thuộc: 7 cạnh, không chu trình; WP-222 là điều kiện đi trước vì nó quyết định
    "đỏ nghĩa là mất hành vi" chứ không phải "đỏ vì đổi chữ"
  ✓ Hoàn tác: chép ba file vào mktemp -d, không có điểm không đảo ngược
  ✓ Kiểm thử: 5 tầng, đối chứng âm bắt buộc từng bead
  ✓ Rủi ro: 5 mục ở §6 delta thiết kế, mỗi mục có cách giảm
  ✓ Sẵn sàng phân rã: mọi giới hạn cứng đã có chữ sẵn ở §4.2; converter không phải nghĩ ra luật nào

Cảnh báo (không chặn)
  - 5 WP trong một pha: chấp nhận được
  - WP-226 gộp siết trần + tài liệu: cùng một lần chốt, không tách

Verdict: PASS → converting-plan-to-beads
```

## 7. Revision history

| Ngày | Thay đổi |
|---|---|
| 2026-09-17 | Tạo (Draft) từ delta thiết kế `20260917b-simplify-roles` |
| 2026-09-17 | Một lượt `reviewing-plan`: thêm ràng buộc "khẳng định kiểm toàn file, không theo mục" cho WP-222 (chặn — nếu không, WP-223/224/225 đỏ vì dời chỗ chứ không vì mất hành vi); buộc lý do đóng bead đi hết bảng §4.3; đổi cách chốt con số ngân sách cấm đoán thành đo-rồi-đặt; thêm ràng buộc ngôn ngữ tiếng Anh và ràng buộc làm tuần tự |
| 2026-09-17 | Cổng `plan-ready-for-beads`: FAIL lần 1 (4 mục), bổ sung tư thế hoàn tác, độ phủ REQ theo WP, chiến lược kiểm thử; PASS lần 2 → `Status: Active`, đóng băng phạm vi pha |
| 2026-09-17 | Errata sau lượt `polishing-beads`: bản chép để hoàn tác do **WP-222** tạo (không phải WP-223) và gồm cả `test/roles-content.test.ts`, vì WP-222 là bead sửa file đầu tiên |
| 2026-09-17 | Áp dụng xong: WP-222 → WP-226 đóng. Điều kiện ra 2 (ba file ≤ 240 dòng) **KHÔNG đạt** — đo được 266 / 135 / 147; trần lấy theo số đo + 10 và ngân sách đổi sang đo khối `## RULES`, lý do ở §4.5 và §4.6 của delta thiết kế |
