# ADR-012 — Một nguồn duy nhất: plugin `paseo-bm-plugin` cài từ npm / paseo.cafe là toàn bộ sản phẩm

| Trường | Giá trị |
|---|---|
| Status | **Accepted** (2026-09-25) |
| Date | 2026-09-25 |
| Owner | hieu.nt10 |
| Thay thế | [ADR-001](ADR-001-plugin-distribution.md) (phân phối bằng payload đi kèm trình cài); [ADR-009](ADR-009-payload-as-npm-package.md) quyết định 4 và 5 (trình cài là đường cài được hỗ trợ; gói thứ hai không nằm trên đường cài) |
| Sửa đổi | [ADR-002](ADR-002-install-ownership-model.md) (hồ sơ cài đặt chỉ còn cho người dùng cũ); [ADR-003](ADR-003-skills-delegation.md) (plugin, không phải trình cài, chạy CLI `skills` sau khi người dùng bấm); [ADR-004](ADR-004-paseo-config-mutation.md) (plugin sửa config qua `config.patch`, không qua file); [ADR-006](ADR-006-role-registration.md) quyết định 1, 4, 6, 7, 8 (ai tạo và gỡ vai trò, ai hỏi đồng ý); [ADR-008](ADR-008-role-settings-written-by-plugin.md) quyết định 2 (plugin được **tạo** ba vai trò chính) |
| Liên quan | [Technical Design](../design/paseo-bm.md) §3, §4, §5, §6, §7 · [PRD](../product/paseo-bm-prd.md) · [hồ sơ paseo.cafe](../operations/paseo-bm-cafe-listing-20260923.md) |
| Quyết định của chủ repo | 2026-09-25: một nguồn duy nhất là `paseo-bm-plugin`; bản cuối của `npx paseo-bm` tự chuyển người dùng cũ; chỉ hỗ trợ Paseo 0.9+; plugin tự tạo ba vai trò, các bước còn lại cần đồng ý qua nút trên Setup |

## Context

Tới 0.3.1, paseo-bm có hai gói npm cùng phiên bản:

- `paseo-bm` — trình cài chạy bằng `npx`: chép payload vào `~/.paseo-bm/plugin/<version>/`, đăng ký plugin dạng thư mục, tạo ba vai trò `bm-*`, hỏi đồng ý bật plugin và cấp tool Paseo cho agent, chạy CLI `skills`, cài `br`/`bv`, có `doctor` và `uninstall`.
- `paseo-bm-plugin` — chính thư mục `plugin/`, tồn tại chỉ vì paseo.cafe đòi gốc gói npm phải là plugin nạp được (ADR-009).

Người dùng cài thẳng từ paseo.cafe nhận giao diện nhưng **thiếu ba vai trò**, nên Manager không tạo được Worker; caveat của listing phải cảnh báo điều đó. Hai đường cài, một đường hỏng, hai gói phải giữ khớp phiên bản.

Paseo 0.9 đã có nguồn npm (`paseo plugin add npm:<gói>`) và tự cập nhật (`paseo plugin update`). Một phân tích đối chiếu từng việc của trình cài (27 việc, 2026-09-25) cho thấy: 5 việc plugin đã làm, 12 việc plugin làm được bằng API sẵn có (chủ yếu `config.patch`), 10 việc không còn cần vì Paseo tự lo. Plugin **không** làm được ba điều: bật `pluginsEnabled` (plugin chưa chạy khi công tắc còn tắt), tự dọn khi bị gỡ (Paseo không có hook gỡ plugin), và sao lưu nguyên file config (SDK chỉ trả một view). Những chỗ còn thiếu là **quy tắc của chính plugin**, không phải API thiếu.

## Decision

1. **Sản phẩm là một gói: `paseo-bm-plugin`.** Người dùng cài bằng paseo.cafe hoặc `paseo plugin add npm:paseo-bm-plugin`, cập nhật bằng `paseo plugin update paseo-bm`. Đó là đường cài duy nhất được hỗ trợ. Entry registry giữ `package: "paseo-bm-plugin"`, `path: "plugin"`.
2. **Chỉ hỗ trợ Paseo 0.9 trở lên.** `paseo-plugin.json` khai `requirements.paseo: ">=0.9.0"`. Người dùng Paseo 0.8 giữ `paseo-bm@0.3.1` hoặc nâng Paseo.
3. **Plugin tự sở hữu thư mục dữ liệu.** Mặc định `~/.paseo-bm` (giữ nguyên dữ liệu của người dùng cũ), plugin **tự tạo** nó khi cần, quyền `0700`. Thư mục Paseo quản lý gói npm có thể đổi mỗi lần cập nhật nên không bao giờ chứa dữ liệu. `install.json` không còn là điều kiện để plugin tin một thư mục dữ liệu.
4. **Plugin tự tạo ba vai trò lần đầu.** Khi plugin thấy thiếu `bm-manager`, `bm-worker` hoặc `bm-reviewer` (lúc mở lối vào, Setup, hay `manager.ensure`), nó tạo provider dẫn xuất và agent profile của vai trò đó qua `config.patch`, theo đúng quy tắc mặc định của trình cài cũ: provider đầu tiên Paseo báo là dùng được, model đầu tiên của provider đó; `paseoTools.enabled` cho Manager và Worker, không cho Reviewer; không bao giờ ghi `command` hay `env`. Nó chỉ tạo **mục còn thiếu**, không sửa mục đã có (ADR-008 quyết định 5: config của Paseo là nguồn sự thật), và báo trên Setup rằng vai trò được tạo với mặc định, đổi được ở tab Agents. ADR-008 quyết định 2 ("plugin không bao giờ tạo ba vai trò chính") hết hiệu lực; phạm vi ghi vẫn chỉ là các mục id bắt đầu bằng `bm-`.
5. **Ba bước còn lại cần một cú bấm có cảnh báo trên Setup**, không gì tự chạy:
   - **Cấp tool Paseo cho agent** (`daemon.mcp.injectIntoAgents`), kèm cảnh báo "áp dụng cho mọi agent trên máy". Plugin ghi lại giá trị trước đó vào thư mục dữ liệu để hoàn tác đúng.
   - **Cài skills** bằng CLI `skills` của bên thứ ba (argv cố định, hạn 300 giây, kiểm lại sau khi chạy), kèm lưu ý đó là công cụ bên thứ ba.
   - **Cài `br`/`bv`**: đã có trên Setup, giữ nguyên.
   Đăng nhập provider: Setup hiện trạng thái và lệnh đăng nhập của chính công cụ đó; plugin không chạy lệnh đăng nhập và không bao giờ thấy thông tin đăng nhập.
6. **Gỡ cài đặt là một nút trên Setup**: "Gỡ cấu hình của paseo-bm" xoá mọi provider và profile `bm-*` (kể cả alias dự phòng), trả `injectIntoAgents` về giá trị đã ghi nếu chính plugin đã bật nó, và chỉ xoá thư mục dữ liệu sau một xác nhận thứ hai (mặc định giữ). Sau đó người dùng chạy `paseo plugin remove paseo-bm`. Gỡ plugin mà không bấm nút thì cấu hình còn lại; README và caveat của listing nói rõ điều này.
7. **`npx paseo-bm` 0.4.0 là bản cuối, chỉ để chuyển đổi.** Nó thay mọi lệnh cũ bằng một việc: nếu máy có bản cài dạng thư mục của paseo-bm, chạy `paseo plugin remove paseo-bm` rồi `paseo plugin add npm:paseo-bm-plugin@<phiên bản của nó>`, và nếu bước sau hỏng thì cài lại thư mục cũ; giữ nguyên dữ liệu, vai trò và công tắc; đánh dấu `install.json` là đã chuyển. Không có bản cài cũ thì nó chỉ in hướng dẫn cài từ paseo.cafe. Sau 0.4.0, `release.yml` chỉ publish `paseo-bm-plugin`, và owner đánh dấu `paseo-bm` deprecated trên npm (cần OTP). Plugin chạy từ bản cài thư mục thì hiện banner trên Setup nhắc chạy `npx paseo-bm` một lần.
8. **Sức khoẻ**: tab và dòng tình trạng của Setup thay `doctor` khi plugin đang chạy. Khi plugin không nạp được, README chỉ tới `paseo plugin ls` và `paseo plugin logs paseo-bm`.
9. **Phiên bản 0.4.0.** Bỏ CLI là đổi hợp đồng công khai mà caveat của listing đã hứa, nên tăng minor.

## Consequences

**Tích cực**
- Một đường cài, một gói, một nơi cập nhật: người dùng từ paseo.cafe nhận đủ sản phẩm.
- Bớt phần lớn mã trong `src/` (sao chép payload, hồ sơ sở hữu, đăng ký, nâng cấp, prune, khoá, preflight, báo cáo CLI) và các test của nó; việc bảo trì còn một gói.
- Cập nhật do Paseo lo (`paseo plugin update`), không còn thư mục phiên bản song song trong `~/.paseo-bm/plugin/`.

**Tiêu cực / phải chấp nhận**
- Người dùng Paseo 0.8 không còn đường lên phiên bản mới.
- Không còn bản sao lưu nguyên file `~/.paseo/config.json` trước khi sửa; thay bằng `config.patch` (daemon kiểm và tự khôi phục file của nó khi lỗi) cộng kiểm revision của plugin — đúng mức ADR-008 đã chấp nhận cho việc sửa vai trò.
- Tạo profile nghĩa là ghi lại cả mảng `agentProfiles`: cùng rủi ro ghi đè đồng thời đã chấp nhận ở ADR-008 quyết định 3.
- Gỡ plugin không qua nút để lại cấu hình `bm-*` và `injectIntoAgents`; chỉ nhắc được bằng tài liệu.
- Một `npx paseo-bm@0.3.x` đã cache vẫn có thể cài ngược lại bản thư mục; chỉ cảnh báo deprecate của npm và bản 0.4.0 giảm được rủi ro này.
- Việc cấp tool Paseo cho agent vẫn là công tắc toàn máy; nếu kiểm trên daemon thật cho thấy `paseoTools.enabled` của từng provider đủ để cấp tool mà không cần công tắc, nút này sẽ được bỏ bằng một quyết định sau.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Giữ hai gói, chỉ để plugin tự tạo vai trò | Vẫn hai đường cài, hai thứ phải phát hành và giữ khớp; chủ repo muốn một nguồn |
| Đổi tên gói duy nhất thành `paseo-bm` | `paseo-bm` 0.1–0.3.1 là trình cài: một phạm vi phiên bản cũ sẽ cho Paseo một gói không nạp được; `npx paseo-bm` hỏng hẳn không kèm lời giải thích; phải đổi entry registry và trusted publisher |
| Plugin tự chuyển bản cài thư mục sang npm | `paseo plugin remove` chạy từ trong plugin dừng chính tiến trình đó giữa chừng; hỏng nửa chừng thì người dùng không còn giao diện nào để gỡ rối |
| Tiếp tục hỗ trợ Paseo 0.8 qua nguồn Git | Thêm một đường cài phải kiểm và viết tài liệu, trái mục tiêu một nguồn |
| Hỏi đồng ý cả việc tạo vai trò | Chủ repo chọn tự tạo: vai trò chỉ là mục `bm-*` của chính paseo-bm, không cấp quyền gì mới; quyền thật (tool Paseo cho mọi agent, chạy công cụ bên thứ ba) vẫn qua nút |
