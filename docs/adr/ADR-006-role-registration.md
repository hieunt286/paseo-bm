# ADR-006 — Đăng ký vai trò bằng provider dẫn xuất cộng agent profile, mở quyền công cụ có cảnh báo

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-15 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-027, REQ-031, REQ-032](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-004](ADR-004-paseo-config-mutation.md) (mở rộng phạm vi) · [ADR-005](ADR-005-manager-as-agent.md) · [Technical Design](../design/paseo-bm.md) |
| Sửa đổi bởi | [ADR-008](ADR-008-role-settings-written-by-plugin.md), quyết định 1 và 5 (Accepted 2026-09-22) |

## Context

ADR-005 chốt Manager và Worker là agent. Muốn chúng tạo và theo dõi agent khác thì phải có hai thứ:

1. **Một chỗ để người dùng chọn công cụ và model cho từng vai trò** — Paseo gọi là agent profile.
2. **Quyền dùng bộ công cụ Paseo** — mặc định agent **không** có.

Dữ kiện đã khảo sát trên máy (Paseo 0.8.0, 2026-09-15):

- `daemon.mcp.enabled` mặc định bật; `daemon.mcp.injectIntoAgents` **mặc định tắt**, và khi bật thì **mọi** agent đều có công cụ Paseo. Trên máy owner nó đang bật sẵn, nhưng không được coi đó là mặc định của người dùng khác.
- Có thể giới hạn theo provider bằng khoá `paseoTools` (`enabled`, `disabledTools`) trong `agents.providers.<id>`.
- Provider **dẫn xuất** khai báo bằng `extends`, và **không bắt buộc** khai báo lại `command`. Ví dụ tối thiểu chỉ cần `extends` cộng `label`.
- `daemon.agentProfiles` là một mảng, mỗi mục gồm `id`, `name`, `icon`, `color`, `provider`, `modeId`, `thinkingOptionId`, `notes`.
- Máy owner **đã có** 6 provider dẫn xuất và 6 profile do paseo-room tạo (tiền tố `room-`). paseo-bm phải sống chung, không được ghi đè.
- ADR-004 trước đây tuyên bố paseo-bm **không** chạm `agents.providers` và `daemon.agentProfiles`. Quyết định này **mở rộng phạm vi đó** vì sản phẩm đã đổi.

## Decision

1. **Đăng ký ba vai trò** dưới tiền tố `bm-`, để không đụng bất cứ thứ gì của người dùng hay của paseo-room:
   - Provider dẫn xuất: `bm-manager`, `bm-worker`, `bm-reviewer`, mỗi cái chỉ gồm `extends` (trỏ tới provider gốc người dùng chọn), `label`, và `paseoTools`.
   - Agent profile tương ứng, có `notes` mô tả rõ khi nào dùng vai trò nào.
2. **Không khai báo `command`, không khai báo `env`.** Vai trò dùng lại đúng nhị phân và đúng phiên đăng nhập sẵn có của provider gốc. Đây là cách giữ lời hứa "không chạm credential": paseo-bm không tạo thư mục nhà riêng cho từng vai trò, không đụng token, không cách ly phiên đăng nhập — khác hẳn paseo-room.
3. **Mở quyền công cụ — báo trước rồi bật, kèm thu hẹp theo vai trò** *(sửa 2026-09-15 theo quyết định của owner)*:
   - Trình cài đặt **thông báo rõ rồi bật `daemon.mcp.injectIntoAgents`**. Cảnh báo phải nói thẳng: bật công tắc này nghĩa là **mọi agent trên máy** đều được quyền tạo, nhắc và dừng agent khác, chứ không riêng ba vai trò của paseo-bm. Bước này **gộp chung một lần hỏi với việc bật plugin**: tương tác thì một câu hỏi nêu đủ hai hệ quả; không tương tác thì cờ `--enable-plugins` phủ cả hai. *(Sửa 2026-09-15 — bản đầu tách thành hai lần đồng ý; owner chốt gộp vì bật plugin mà không mở quyền thì Manager không tạo được Worker.)*
   - Vẫn đặt `paseoTools.enabled = true` cho `bm-manager` và `bm-worker`, và **không** đặt cho `bm-reviewer`. Đây là lớp thu hẹp bổ sung, có tác dụng thì tốt, không có tác dụng thì cũng không hại.
   - Ghi vào hồ sơ nếu chính paseo-bm là bên bật công tắc, để lệnh gỡ trả lại đúng trạng thái cũ.
   - *Bản đầu của ADR này chọn đường ngược lại — chỉ mở theo provider và tránh công tắc toàn cục. Owner chốt đổi vì đường hẹp chưa chắc có tác dụng, và một sản phẩm không tạo được agent thì vô dụng. Cái giá là phạm vi quyền rộng hơn, nên nó được đánh đổi bằng một cảnh báo tường minh thay vì làm lặng lẽ.*
4. **Đồng ý phải tường minh, nhưng gộp với đồng ý bật plugin.** Cho một agent quyền tạo và dừng agent khác là một ranh giới an ninh, nên `--yes` **không bao giờ** được tính là đồng ý. Nhưng nó đi chung một lần hỏi với việc bật plugin, vì hai việc này chỉ có nghĩa khi đi cùng nhau.
5. **Chỉ ghi phần của mình.** Với `daemon.agentProfiles` là một mảng, paseo-bm đọc, chỉ thêm hoặc sửa các mục có tiền tố `bm-`, giữ nguyên thứ tự và nội dung mọi mục khác, rồi ghi lại. **Không bao giờ thay cả mảng** — đây chính là chỗ paseo-room có thể nuốt mất thay đổi song song.
6. **Chỉ dẫn vai trò là tài sản đi kèm phiên bản**, nằm trong payload plugin và được ghi vào thư mục cài đặt như mọi file khác: có hash, có phân loại quyền sở hữu, có backup khi ghi đè (ADR-002).
7. **Gỡ cài đặt** thì xoá đúng các mục `bm-*` trong `agents.providers` và `daemon.agentProfiles`, trả `daemon.mcp.injectIntoAgents` về trạng thái cũ nếu chính paseo-bm đã bật, và giữ nguyên mọi thứ khác.
8. **Ghi trạng thái trước theo từng khoá, không phải một cờ boolean.** Hồ sơ lưu `{ present, value }` của `daemon.mcp.injectIntoAgents` tại thời điểm trước khi paseo-bm chạm vào, vì "trước đó khoá không tồn tại" khác với "trước đó là `false`". Lúc gỡ thì sửa đúng khoá đó theo trạng thái đã ghi, có kiểm tra ghi song song — **không** khôi phục nguyên cả file backup, vì làm vậy sẽ xoá mất mọi thay đổi cấu hình phát sinh sau khi cài. Nếu giá trị hiện tại khác với giá trị paseo-bm đã đặt thì coi như người khác đã đổi và **không** đụng vào. *(Errata 2026-09-15, bm-tm2: cùng quy tắc áp cho `pluginsEnabled` qua trường `paseo.pluginsEnabledPrevious`, và hồ sơ ghi thêm `paseo.createdConfigContainers` — các container `config.json` do chính paseo-bm tạo — để lệnh gỡ xoá chúng khi đã rỗng trở lại; container có sẵn hoặc còn nội dung khác thì giữ. Xem Design §3.2.)*
9. **Reviewer: ràng buộc ở hai lớp.** Không đặt `paseoTools` cho `bm-reviewer` là lớp cấu hình, nhưng khi công tắc toàn cục đã bật thì **chưa chắc** lớp này vô hiệu hoá được quyền. Vì vậy ràng buộc "Reviewer không tạo agent" phải được viết thẳng trong chỉ dẫn vai trò, và phần nghiệm thu phải kiểm tra thực tế Reviewer có nhận được công cụ quản lý agent hay không. Nếu hoá ra nó vẫn nhận, thì lớp chỉ dẫn là thứ duy nhất chặn review đệ quy và điều đó phải được ghi nhận như một rủi ro đã biết.

## Consequences

**Tích cực**
- Người dùng chọn công cụ cho từng vai trò ngay trong Paseo, và thấy vai trò trong bộ chọn model như mọi profile khác.
- Không đụng credential: không thư mục nhà riêng, không token, không cách ly phiên đăng nhập. Bằng chứng phủ định của PRD giữ nguyên giá trị.
- Tiền tố `bm-` làm cho việc gỡ sạch trở nên xác định, và sống chung được với paseo-room.
- Ghi trạng thái trước theo từng khoá cho phép hoàn tác đúng chỗ mà không đè lên thay đổi của người khác.

**Tiêu cực / phải chấp nhận**
- Phạm vi ghi vào `config.json` **rộng hơn hẳn** so với ADR-004: từ đúng một trường boolean lên ba provider, ba profile, và có thể cả công tắc MCP. Bù lại bằng quy tắc chỉ-ghi-phần-của-mình và bằng backup trước mỗi lần ghi.
- Sửa một phần tử trong mảng `agentProfiles` khó hơn sửa một trường gốc; cần đọc–sửa–ghi cẩn thận và kiểm tra lại sau khi reload.
- **Quyền rộng hơn mong muốn:** bật công tắc toàn cục nghĩa là mọi agent trên máy — kể cả những agent không liên quan tới paseo-bm — đều được quyền tạo, nhắc và dừng agent khác. Owner chấp nhận có ý thức, đổi lại phải cảnh báo tường minh lúc cài và `doctor` phải hiển thị trạng thái này.
- **Lớp thu hẹp theo vai trò có thể vô tác dụng** khi công tắc toàn cục đã bật; khi đó "Reviewer không có công cụ" chỉ còn được bảo đảm bằng chỉ dẫn vai trò chứ không phải bằng cấu hình (quyết định 9).
- Provider dẫn xuất kế thừa hạn mức và trạng thái đăng nhập của provider gốc; provider gốc hỏng thì cả ba vai trò hỏng theo.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Chỉ mở quyền theo provider, tránh công tắc toàn cục | **Đây là lựa chọn ban đầu của ADR này và đã bị owner đảo ngược ngày 2026-09-15.** Lý do loại: chưa có bằng chứng quyền theo provider có tác dụng khi công tắc toàn cục tắt, và một sản phẩm không tạo được agent thì vô dụng. Đường hẹp vẫn được giữ như lớp bổ sung |
| Bật công tắc toàn cục **lặng lẽ**, không báo người dùng | Đây mới là phương án thật sự đáng loại: thay đổi ranh giới an ninh của cả máy mà người dùng không biết |
| Bật `paseoTools` thẳng trên provider gốc (`codex`, `claude`) | Vẫn ảnh hưởng mọi agent dùng provider đó, trong khi chi phí tạo provider dẫn xuất gần như bằng không |
| Sao chép mô hình paseo-room: provider riêng kèm thư mục nhà và phiên đăng nhập riêng cho từng vai trò | Kéo theo trách nhiệm quản lý credential mà PRD đã tuyên bố không nhận; cũng buộc người dùng đăng nhập lại nhiều lần cho cùng một công cụ |
| Không đăng ký profile, để Manager truyền thẳng provider và model khi tạo agent | Người dùng mất chỗ để xem và sửa cấu hình vai trò; và cấu hình sẽ nằm rải trong chỉ dẫn thay vì ở nơi Paseo dành cho nó |
| Ghi đè cả mảng `agentProfiles` cho gọn | Chính là lỗi đã thấy ở paseo-room: mất thay đổi song song từ ứng dụng |
