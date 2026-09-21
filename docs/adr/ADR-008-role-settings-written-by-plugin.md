# ADR-008 — Plugin ghi cấu hình vai trò vào config Paseo qua `config.patch`; alias dự phòng cho mọi vai trò

| Trường | Giá trị |
|---|---|
| Status | **Proposed**. Owner chọn hướng R1 ngày 2026-09-21 (Q3 a của `req-20260921T111242Z`). Chuyển Accepted khi owner duyệt [PRD delta 20260921](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) §9 |
| Date | 2026-09-21 |
| Owner | hieu.nt10 |
| Sửa đổi | [ADR-004](ADR-004-paseo-config-mutation.md) quyết định 1; [ADR-006](ADR-006-role-registration.md) quyết định 1 và 5 |
| Liên quan | [PRD delta 20260921](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) REQ-064, REQ-065, REQ-066 · [Design delta 20260921](../design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) §4.3, §4.4 · [Đề xuất 20260921](../design/paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) §4.2, §4.7 |

## Context

Owner muốn cấu hình lại provider, model, thinking và mode của từng vai trò **ngay trong Beads Manager**, sau khi đã cài bằng `npx paseo-bm`. Owner cũng muốn một chuỗi dự phòng khi hết hạn mức cho cả ba vai trò (REQ-064 → REQ-066; Q8 c). Hôm nay chỉ có hai đường, và cả hai đều không làm được điều đó:
- `npx paseo-bm install --reconfigure`: phải dùng terminal, chạy trình cài;
- Settings → Agent profiles của Paseo: sửa được profile, nhưng không biết gì về chuỗi dự phòng.

Dữ kiện (đề xuất §1, đã kiểm trên Paseo 0.8):
- `paseo.config.patch()` của SDK plugin gộp sâu mục `agents.providers`, nên sửa được một alias mà không đụng alias khác. Provider registry cập nhật ngay, không cần reload.
- Cũng lời gọi đó **thay cả mảng** `daemon.agentProfiles`, và **không có** phiên bản hay điều kiện nào để so-rồi-ghi.
- Daemon ghi xuống file trước; lỗi thì trả lại file cũ.
- Plugin chạy **trong** daemon. Để plugin sửa file `config.json` rồi `paseo daemon reload` từ trong chính daemon là đường chưa kiểm: nó có thể nạp lại chính plugin giữa lúc RPC đang chạy (phương án R4 của đề xuất).
- Hook `before("agent.create")` nhận ra vai trò **chỉ bằng tên provider** (M5), nên mỗi agent dự phòng cần một alias mà hook nhận ra đúng vai.
- ADR-004 QĐ1 chọn "tích hợp qua CLI, không phụ thuộc SDK"; ADR-004 §Context loại `config.patch` vì nó thay cả mảng.
- ADR-006 QĐ1 đăng ký **ba** vai trò; QĐ5 "không bao giờ thay cả mảng".

## Decision

1. **Plugin là bên ghi thứ hai của `config.json`**, bên cạnh trình cài. Plugin chỉ ghi khi người dùng bấm Lưu trên màn Roles & models, và chỉ qua `paseo.config.patch()` của SDK. Plugin không sửa file trực tiếp, không gọi `paseo daemon reload`.
2. **Phạm vi ghi của plugin** là đúng các mục có id bắt đầu bằng `bm-`:
   - `agents.providers.bm-manager` / `bm-worker` / `bm-reviewer`: chỉ `extends`;
   - `agents.providers.bm-<vai trò>-fallback-<n>`, n = 1…3, cho `manager`, `worker`, `reviewer`: `{ extends, label }`, cộng `paseoTools.enabled: true` cho Manager và Worker. Alias dự phòng của Reviewer **không bao giờ** có `paseoTools` (ADR-006 QĐ3). Plugin tạo và xoá các alias này;
   - trong `daemon.agentProfiles`, chỉ mục `bm-manager` / `bm-worker` / `bm-reviewer`: `model`, `thinkingOptionId`, `modeId`.

   Plugin **không bao giờ tạo** alias hay profile của ba vai trò chính; đó vẫn là việc của trình cài (ADR-006).
3. **Ngoại lệ có kiểm cho ADR-006 QĐ5.** Vì `config.patch` thay cả mảng `agentProfiles`, mỗi lần ghi của plugin theo đúng năm bước:
   1. Đọc cấu hình. Tính `revision` (sha256 của mọi alias `bm-*` và toàn bộ mảng profile). Khác `revision` lúc người dùng mở màn hình → **không ghi**.
   2. Dựng mảng từ **đúng bản vừa đọc**, chỉ thay mục `bm-*` tại chỗ.
   3. Ghi bằng **một** lần `patch`.
   4. Đọc lại. Profile không phải `bm-*` nào khác bản ở bước 1 thì **báo** tên nó; không tự ghi lại, vì ghi lại cũng là thay cả mảng.
   5. Mọi lần ghi của plugin đi qua một mutex trong tiến trình.

   Rủi ro còn lại, owner chấp nhận ngày 2026-09-21 (Q3 a): một thay đổi trong app rơi đúng vào khoảng giữa bước 1 và bước 3 vẫn bị đè, và chỉ được báo ở bước 4.
4. **Alias dự phòng không có profile.** Model, thinking và mode của mỗi mục dự phòng nằm trong `<install home>/role-fallback.json`. Đó là dữ liệu người dùng, cùng loại với `role-extras.json`. Chuỗi dự phòng là khái niệm riêng của paseo-bm, Paseo không có chỗ cho nó.
5. **Nguồn sự thật của cấu hình vai trò là config Paseo.** `install.json` `roles[]` giữ hình dạng cũ, nhưng chỉ còn là bản ghi "trình cài đã ghi gì lần cuối". Trình cài **gộp** thay vì thay nguyên mục `bm-*` (REQ-062 c), nên thay đổi làm ở app, trên màn Roles & models hay trong Settings của Paseo, còn nguyên qua mọi lần cài lại.
6. **Không đổi:**
   - trình cài vẫn tích hợp qua CLI và sửa file tối thiểu có backup (ADR-004 QĐ2–QĐ8);
   - không `command`, không `env` trên alias, không chạm credential (ADR-006 QĐ2);
   - luật tiền tố `bm-` cho gỡ cài đặt (ADR-006 QĐ7), nên alias dự phòng cũng bị gỡ;
   - Reviewer không có `paseoTools` (ADR-006 QĐ3, QĐ9).

## Consequences

**Tích cực**
- Một nguồn sự thật: màn Roles & models và Settings → Agent profiles của Paseo luôn nói cùng một điều.
- Người dùng app không cần terminal để đổi vai trò (REQ-028).
- Không có đường "sửa file rồi reload từ trong daemon".
- Provider registry cập nhật ngay, nên Worker tạo sau khi lưu dùng cấu hình mới.

**Tiêu cực / phải chấp nhận**
- **Ghi đè song song vẫn có thể xảy ra** trong `agentProfiles`: bước 1 và bước 4 chỉ thu hẹp cửa sổ và báo, không chặn được. Bảo đảm thật cần Paseo có RPC sửa **một** profile theo `id` (đề nghị U3, đề xuất §5.2).
- Plugin phụ thuộc hợp đồng `config.get` / `config.patch` của SDK 0.8. Paseo đổi cách gộp thì phần ghi này có thể hỏng. Giảm thiểu: test với daemon giả, kiểm sau khi ghi.
- `config.json` có thêm tối đa chín alias `bm-<vai trò>-fallback-*` (ba mỗi vai trò) không có profile. Chúng hiện trong bộ chọn provider của Paseo.
- Hai bên ghi (trình cài và plugin) có thể chạy cùng lúc. Trình cài đã có kiểm ghi song song trên file (ADR-004 QĐ8), còn plugin có `revision`. Không bên nào khoá được bên kia.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| R2 — file riêng của paseo-bm, áp ở hook | Hai nguồn sự thật: Settings của Paseo nói một model, Worker chạy model khác. Đổi provider gốc vẫn phải ghi `extends` vào config |
| R3 — màn hình chỉ sinh lệnh `npx paseo-bm install --reconfigure --role …` | Không phải "trong Beads Manager"; `npx` cần mạng; CLI không có cờ cho thinking và chuỗi dự phòng |
| R4 — plugin chạy lõi đọc-sửa-ghi file của CLI rồi `paseo daemon reload` | Plugin ghi file mà chính daemon cũng ghi; reload gọi từ trong daemon chưa kiểm, có thể nạp lại chính plugin giữa chừng |
| Đợi Paseo có RPC sửa một profile (U3) | Chưa có, và không biết khi nào có. Khi có thì bước 2–4 của QĐ3 được thay bằng lời gọi đó, không đổi gì khác |
