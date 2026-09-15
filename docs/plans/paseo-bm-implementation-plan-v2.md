# paseo-bm — Implementation Plan (bản 2)

| Trường | Giá trị |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-15 — hieu.nt10 |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Routing decision | [PRD §0](../product/paseo-bm-prd.md#0-routing-decision) (canonical owner) |
| Source PRD | [paseo-bm PRD](../product/paseo-bm-prd.md) |
| Source Technical Design | [paseo-bm Technical Design, bản 2](../design/paseo-bm.md) |
| Related ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-003](../adr/ADR-003-skills-delegation.md) · [ADR-004](../adr/ADR-004-paseo-config-mutation.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) · [ADR-006](../adr/ADR-006-role-registration.md) |
| Phase | Phase 1 MVP, chia hai chặng: **Phase 1a MVP** (nền tảng và cài đặt) → **Phase 1b MVP** (điều phối) |
| Thay cho | [Bản 1](paseo-bm-implementation-plan.md), Superseded ngày 2026-09-15 |

## 1. MVP-Lock

### Phase 1a MVP — nền tảng và cài đặt

- **Trong chặng này:** REQ-001 → REQ-004, REQ-005(a)(b)(c), REQ-006 → REQ-015, REQ-027 (cấu hình vai trò lúc cài), REQ-031 (đăng ký vai trò và mở quyền công cụ), REQ-032 (khung và đóng gói bộ chỉ dẫn vai trò). Chỉ số M-1 → M-9.
- **Exit criteria:**
  1. Mọi AC của các REQ trên đạt, có test tương ứng.
  2. CI xanh trên macOS và Linux, Node 22 và 24, gồm smoke trên **gói npm đã đóng gói**.
  3. Demo trên HOME sạch đạt M-1 → M-9.
  4. Trên máy đã có sẵn cấu hình paseo-room, cài paseo-bm xong thì **mọi mục `room-*` không đổi một byte**.
  5. `doctor` báo đúng trạng thái ba vai trò và quyền công cụ của chúng.
  6. **WP-120 ghi PASS** cho toàn bộ M-1 → M-9 trên daemon thật.

### Phase 1b MVP — điều phối

- **Trong chặng này:** REQ-020 → REQ-026, REQ-033, REQ-034 (báo cáo có cấu trúc), REQ-035 (Manager nhắc skills), REQ-036 (phân loại quy mô yêu cầu), REQ-037 (lan can hành vi cho review và polish), và **nội dung** ba bộ chỉ dẫn vai trò theo REQ-032(b). Chỉ số M-10 → M-18. Bao gồm cả chặng **implement**: Worker đi tới khi các bead thuộc yêu cầu xong xuôi.
- **Exit criteria:**
  1. Mở Beads Manager từ sidebar cho ra đúng một Manager cho mỗi workspace.
  2. Bộ **5 yêu cầu mẫu** (định nghĩa cụ thể ở WP-117) chạy trên repo dùng một lần và **M-10 → M-18 đều đạt**; trong đó hai yêu cầu đi hết chặng implement.
  3. Người dùng chat thẳng được với Worker; Worker hỏi lại mỗi khi vướng thay vì tự quyết; không agent nào tự xoá agent; không có commit nào do agent tạo.
  4. Một phiên bản prerelease có trên npm kèm provenance, dist-tag `next`.
  5. README đạt REQ-015 và mô tả đúng vòng lặp điều phối.

### Ngoài phạm vi Phase 1 (dễ bị tưởng là có)

- Worker tự commit, push, hay tạo pull request. **Worker CÓ viết mã sản phẩm** — đó là REQ-022(e), nằm trong WP-115 của Phase 1b.
- REQ-005(d) (giao diện Beads Manager là dấu hiệu nhìn thấy được) **không** thuộc Phase 1a: giao diện nằm ở WP-113, Phase 1b.
- Bảng báo cáo tiến độ bead dạng biểu đồ (REQ-016, REQ-017, Phase 2).
- Lệnh `configure` riêng (REQ-028), giới hạn số Worker song song (REQ-029), lịch sử phiên (REQ-030).
- Daemon từ xa (REQ-019), Windows nguyên bản, Docker.
- Cách ly credential theo vai trò kiểu paseo-room: ADR-006 chốt **không** làm.

### Default checkpoint posture

Mọi WP là thay đổi mã cục bộ, hoàn tác bằng git. Trên máy người dùng, mọi thứ paseo-bm ghi đều đảo ngược được: payload giữ mọi phiên bản, `config.json` có backup trước khi sửa, lệnh gỡ trả về trạng thái trước và xoá đúng các mục `bm-*`. **Ba điểm không đảo ngược được:**

1. `npm publish` — npm không cho gỡ sau 72 giờ → mọi bản Phase 1 đi dist-tag `next`.
2. Bước chạy hộ CLI `skills` — paseo-bm không gỡ được skills đã cài → đồng ý rõ ràng trước khi chạy.
3. `--prune` xoá backup — không khôi phục được → chỉ chạy khi người dùng yêu cầu, và bản xem trước phải liệt kê rõ sẽ mất gì.

Ngoài ra, **hành động của agent không đảo ngược tự động được**: Worker sửa tài liệu, beads **và mã nguồn** trong workspace thật. Containment gồm bốn lớp: ranh giới ở REQ-026 (không git, hỏi khi vướng); hợp đồng an toàn trong WP-115; người dùng xem lại bằng `git diff` trước khi commit; và quyền dừng agent bất cứ lúc nào. Lưu ý `git diff` **không** thấy được thay đổi ngoài repo, file bị ignore, hay tác động lên dịch vụ ngoài — đó là lý do WP-115 phải cấm những việc đó ngay từ đầu thay vì trông vào việc rà lại sau.

> Sau khi mục này được duyệt, phạm vi không được thêm nếu không có delta-change.

## 2. Work Packages

### Phase 1a

#### WP-101: Khung dự án, đóng gói và phát hành

- **Outcome:** TypeScript/ESM, build bằng `tsup`, `bin: paseo-bm`, script typecheck/lint/test/build, CI macOS + Linux trên Node 22 và 24, smoke chạy trên gói `npm pack`, workflow phát hành OIDC kèm provenance chạy tới dry-run. Không có `preinstall`/`postinstall`; `prepack` được phép vì chạy trên máy người phát hành.
- **Requirement / AC coverage:** REQ-001(c) một phần (nhị phân chạy được); NFR chuỗi cung ứng; M-6.
- **Design refs:** Design §2.3, §10.
- **Prerequisites:** none.
- **Exit condition:** CI xanh 4/4 tổ hợp; cài tarball vào thư mục tạm rồi chạy `--help` và `--version` thành công; release workflow dry-run thành công.

#### WP-102: Nền tảng CLI

- **Outcome:** Lớp dòng lệnh (định tuyến, đăng ký đủ cờ Design §4.2, phát hiện TTY, mã 2 khi dùng sai, **giao diện hỏi đáp tiêm được**); sổ đăng ký mã lỗi; giải đường dẫn và từ chối install home nguy hiểm; ghi atomic có hash và quyền `0700`/`0600`; hồ sơ `install.json` schema v1 gồm `roles[]`; phân loại quyền sở hữu 5 trạng thái; khoá tiến trình; mô hình Action và hai bộ render; che bí mật ba kênh; **bộ khung chặn ghi**.
- **Requirement / AC coverage:** REQ-001(c), REQ-004, REQ-008(a)(b)(c)(d), REQ-013(a)(b)(d), REQ-014; bộ khung cho REQ-008(e).
- **Design refs:** Design §3, §4.1 → §4.4, §6, §8.
- **Prerequisites:** WP-101.
- **Risk boundaries:** đây là nơi đặt phần lớn bất biến an toàn. WP này giao **bộ khung** chặn ghi; việc bật cho từng lệnh là điều kiện ra của WP-105, WP-107, WP-110, WP-111.
- **Exit condition:** mọi cờ đăng ký đủ và dùng sai trả mã 2; một lần cài tương tác giả lập chạy trọn bằng bộ hỏi đáp kịch bản; 5 trạng thái quyền sở hữu có test; từ chối install home nguy hiểm và chống ghi xuyên symlink có test bảng; che bí mật xanh ở ba kênh; test chứng minh trong `~/.paseo` chỉ đọc `config.json`; khoá tiến trình từ chối lần chạy thứ hai và thu hồi được khoá chết.

#### WP-103: Lớp tích hợp Paseo và preflight

- **Outcome:** Lớp bọc CLI `paseo` (`daemon status|reload`, `plugin install|ls|logs|remove`, tất cả `--json`, tiến trình con không qua shell, timeout 15 giây, parse phòng thủ) và preflight chặn mọi thao tác ghi khi môi trường chưa đạt.
- **Requirement / AC coverage:** REQ-002; phần gọi Paseo của REQ-005.
- **Design refs:** Design §6, §8, §9.3; ADR-004.
- **Prerequisites:** WP-101, WP-102.
- **Assumptions:** phân biệt `enabled` với `status` — mọi kiểm tra "plugin chạy chưa" đọc `status`.
- **Exit condition:** mọi nhánh preflight thất bại dừng trước khi ghi và trả mã 3 kèm cách khắc phục; adapter có test cho JSON hợp lệ, sai hình dạng, mã thoát khác 0, và tiến trình treo bị giết đúng hạn.

> **WP-104 đã được gỡ bỏ (2026-09-15).** Nó là một bước khảo sát thuộc giai đoạn thiết kế chứ không phải một hạng mục triển khai, và bảng phụ thuộc cũ lại mâu thuẫn với chính phần mô tả của nó. Hai câu hỏi thực nghiệm mà nó định trả lời đã chuyển đi: nội dung cảnh báo thuộc **WP-107**, còn việc Reviewer có thật sự bị từ chối công cụ hay không (Q-028) là một hạng mục bắt buộc trong bộ nghiệm thu **WP-117**. Các WP giữ nguyên số cũ để không phải đánh số lại toàn bộ.

#### WP-105: Luồng cài và cập nhật

- **Outcome:** Lệnh `install` đầu-cuối: preflight → planner → xem trước → xác nhận → applier → đăng ký plugin; cài bên cạnh theo phiên bản; nhận diện cài mới, cập nhật, hạ cấp, sửa chữa; dọn payload dở dang; wizard khi có TTY; mã 6 khi không TTY và không `--apply`.
- **Requirement / AC coverage:** REQ-001(a)(b), REQ-003, REQ-005(a)(c), REQ-008 (áp dụng trong luồng thật, gồm REQ-008(e) cho lệnh này), REQ-009, REQ-010(a)(b)(c).
- **Design refs:** Design §2.1, §9.1, §9.3.
- **Prerequisites:** WP-102, WP-103, WP-108 (cần payload để copy).
- **Risk boundaries:** chứa ranh giới trạng thái bền vững — payload, hồ sơ và đăng ký phía Paseo phải nhất quán sau mọi điểm ngắt.
- **Assumptions:** nâng cấp copy sang thư mục phiên bản mới nên mọi đích đều `missing`; ba trạng thái xung đột chỉ xảy ra khi cài lại cùng phiên bản hoặc sửa chữa.
- **Exit condition:** chạy hai lần cho 0 Action; ma trận điểm ngắt xanh; không TTY và không `--apply` trả mã 6 với 0 thao tác ghi; guard chặn ghi bật và xanh; `install --apply` với daemon giả lập dưới 20 giây trong CI.

#### WP-106: Cấu hình vai trò lúc cài và uỷ quyền đăng nhập

- **Outcome:** Bước hỏi tên và chọn provider/model cho từng vai trò (Manager, Worker, Reviewer) từ danh sách Paseo trả về; cờ `--role <role>=<provider>/<model>` và `--reconfigure`; kiểm tra provider đã đăng nhập chưa; chưa thì mời chạy **đúng lệnh login của chính công cụ đó** sau khi người dùng đồng ý, từ chối thì in hướng dẫn; ghi `roles[]` vào hồ sơ.
- **Requirement / AC coverage:** REQ-027 (a→e).
- **Design refs:** Design §4.2, §6, §9.1; ADR-006 quyết định 2.
- **Prerequisites:** WP-102, WP-103.
- **Risk boundaries:** đây là chỗ chạm tới xác thực. **paseo-bm không đọc, không nhập hộ, không lưu credential** — chỉ gọi lệnh login của công cụ gốc rồi đứng ngoài. Cần bằng chứng phủ định riêng.
- **Exit condition:** kiểm định `--role` sai định dạng trả mã 2 với `E_BAD_ROLE_SPEC` và 0 thao tác ghi; chế độ không tương tác thiếu cấu hình thì dùng mặc định và cảnh báo chứ không treo; test chứng minh không có đường mã nào đọc file credential; provider chưa đăng nhập cho ra `W_PROVIDER_NOT_LOGGED_IN` mà không chặn cài.

#### WP-107: Đăng ký vai trò, bật plugin và mở quyền công cụ — một lần đồng ý duy nhất

> **Gộp WP-109 vào đây (2026-09-15).** Hai WP cũ cùng sửa `config.json`, cùng cần một lời cảnh báo tin cậy, cùng reload, cùng rollback, cùng ghi hồ sơ. Sau khi owner chốt gộp hai việc thành **một lần hỏi**, tách chúng ra hai WP sẽ khiến không ai sở hữu trọn vẹn cái prompt đó.

- **Outcome:** Ghi `agents.providers.bm-manager|bm-worker|bm-reviewer` (chỉ `extends`, `label`, `paseoTools`) và thêm/sửa **chỉ** các mục `bm-*` trong mảng `daemon.agentProfiles`; **báo trước rồi bật `daemon.mcp.injectIntoAgents`** kèm cảnh báo nêu rõ điều đó cho **mọi** agent trên máy quyền tạo và dừng agent khác (tương tác thì hỏi đồng ý, không tương tác thì cần `--enable-agent-tools`); ghi vào hồ sơ nếu chính paseo-bm bật; backup trước khi ghi; reload và xác minh.
- **Requirement / AC coverage:** REQ-031 (a→e), REQ-006 (a→e), REQ-005(b), REQ-010(d), M-7.
- **Design refs:** Design §3.4, §9.1; ADR-006 toàn bộ; ADR-004 (điều khoản 7 đã được ADR-006 thay thế).
- **Prerequisites:** WP-105, WP-106.
- **Nội dung gộp từ WP-109:** sau khi đăng ký plugin, hiện **một** cảnh báo tin cậy nêu đủ hai hệ quả (plugin là mã không sandbox; mọi agent trên máy được quyền tạo, nhắc, dừng agent khác) rồi xin **một** lần đồng ý — không tương tác thì cần `--enable-plugins`. Được đồng ý thì backup, sửa `pluginsEnabled` và `daemon.mcp.injectIntoAgents`, reload, kiểm `appliedPaths`, poll `plugin ls` tới `status: "running"` trong 30 giây; reload lỗi thì khôi phục backup rồi reload lại. Từ chối thì vẫn cài xong, plugin không chạy, trả mã 4 ở chế độ không tương tác. Hồ sơ ghi **trạng thái trước theo từng khoá** (`present` và `value`) chứ không phải một cờ boolean, để lệnh gỡ hoàn tác đúng chỗ.
- **Risk boundaries:** ghi vào cấu hình của phần mềm khác, và mở một ranh giới an ninh (quyền tạo agent). Miền bằng chứng và miền hoàn tác riêng.
- **Exit condition:** ghi vào một `config.json` fixture **đã có sẵn 6 provider và 6 profile `room-*`** rồi khẳng định mọi mục `room-*` không đổi một byte; mảng `agentProfiles` giữ nguyên thứ tự; chạy lại không ghi lại khi mục đã đúng; từ chối mở quyền thì vẫn cài xong và trả mã 4 ở chế độ không tương tác; ghi song song thì thử lại đúng một lần rồi dừng với `E_CONFIG_CONCURRENT_WRITE`; **bốn trạng thái ban đầu của công tắc MCP đều có test** — khoá vắng mặt, `false`, `true`, và trường hợp người khác đổi giá trị sau khi cài — và hồ sơ ghi đúng `previous` cho từng trường hợp.

#### WP-108: Payload plugin và bộ chỉ dẫn vai trò

- **Outcome:** **Khung payload và hợp đồng**, không phải hành vi: manifest, cấu trúc thư mục, `shared/contracts.ts` (định nghĩa Zod cho ba RPC), `shared/version.ts` sinh lúc build, `tsconfig.json`, bước đóng gói và typecheck trong CI, cùng **ba file `roles/*.md` ở dạng khung** có sẵn tiêu đề mục bắt buộc. Hành vi phía server thuộc WP-112, phía client thuộc WP-113, còn **nội dung** ba file vai trò thuộc WP-114 → WP-116 và WP-119.
- **Requirement / AC coverage:** REQ-005(d), REQ-032 (a) phần đóng gói và (c) cập nhật theo phiên bản.
- **Design refs:** Design §2.4, §2.5.
- **Prerequisites:** WP-101.
- **Risk boundaries:** ràng buộc riêng của client Paseo — chỉ primitive React Native, màu lấy từ `theme.colors`, kiểm tra bố cục compact, không phần tử HTML, không `node:` trong client.
- **Exit condition:** typecheck payload xanh; rà soát mã không thấy import `node:` trong `client/`; manifest và cấu trúc thư mục đúng; ba file `roles/*.md` tồn tại với **đủ tiêu đề mục bắt buộc** nhưng chưa cần nội dung; hợp đồng Zod cho ba RPC biên dịch được; `npm pack` chứa đủ `plugin/`. **Không** khẳng định nội dung hành vi ở đây — đó là điều kiện ra của WP-114 → WP-116.

> **WP-109 đã được gộp vào WP-107 (2026-09-15).** Toàn bộ nội dung — cảnh báo tin cậy, xin đồng ý, backup, sửa `pluginsEnabled`, reload, kiểm `appliedPaths`, poll tới `status: "running"`, khôi phục khi reload lỗi, ghi ai bật vào hồ sơ — nay thuộc WP-107, cùng với việc đăng ký vai trò và mở quyền công cụ. Lý do: owner chốt gộp thành **một lần hỏi duy nhất**, nên phải có đúng một WP sở hữu prompt đó và toàn bộ đường ghi `config.json`.

#### WP-110: Skills — dò và hỗ trợ cài

- **Outcome:** Dò 5 skill bắt buộc ở ba thư mục, tôn trọng biến môi trường, đi theo symlink, chỉ đọc; báo cáo theo agent; khi thiếu thì hiện argv dựng sẵn ngay trong câu hỏi đồng ý, chạy CLI `skills` ở chế độ symlink sau khi được đồng ý, dò lại và báo trước/sau; ghi nhớ từ chối và `--ask-skills-again`; timeout 300 giây; `--json` thì đẩy output tiến trình con sang stderr; SIGINT thì ghi `assistOutcome: "interrupted"`.
- **Requirement / AC coverage:** REQ-007 (a→j), REQ-010(e), REQ-013(c), M-8, M-9.
- **Design refs:** Design §6, §7, §8; ADR-003.
- **Prerequisites:** WP-102, WP-105.
- **Risk boundaries:** hai miền khác nhau — **dò** là đọc file thuần tuý, **hỗ trợ cài** là chạy tiến trình ngoài có ranh giới tin cậy.
- **Exit condition:** ma trận M-8 xanh; đầu vào xấu bị từ chối ở mã 2 với 0 thao tác ghi; CLI giả lập ngủ vĩnh viễn bị giết đúng hạn và mã thoát không đổi; `--json` vẫn cho stdout hợp lệ; SIGINT để lại hồ sơ hợp lệ và nhả khoá; lần cài tương tác thuận lợi dừng **đúng 3 lần xác nhận** (bằng chứng duy nhất cho M-1); guard chặn ghi xanh.

#### WP-111: `doctor`, `uninstall` và `prune`

- **Outcome:** `doctor` không ghi, chỉ gọi hai lệnh Paseo chỉ-đọc, không gọi CLI `skills`, không chạm mạng; báo thêm trạng thái ba vai trò và quyền công cụ. `uninstall` gỡ theo hồ sơ, xoá mục `bm-*` trong `agents.providers` và `agentProfiles`, trả `injectIntoAgents` về cũ nếu chính ta bật, tự xoá payload, giữ file `user-modified`, `--restore-backups`, xử lý nhánh daemon không chạy, **không đụng agent đang tồn tại**. `--prune` chỉ chạy khi được yêu cầu.
- **Requirement / AC coverage:** REQ-011, REQ-012 (a→h); Design Q-016.
- **Design refs:** Design §4.1, §9.4.
- **Prerequisites:** WP-105, WP-107, WP-109, WP-110.
- **Exit condition:** M-5 theo phát biểu chính xác (HOME giả, không file sửa tay, daemon chạy, người dùng bỏ backup → install home không còn và `config.json` không còn khoá nào do paseo-bm ghi; khoá `plugins: {}` do Paseo để lại không tính); ba nhánh được phép giữ lại có test riêng; mục `room-*` vẫn nguyên sau khi gỡ; `doctor` sau gỡ báo "chưa cài" và mã 0; test bảng cho phép gọi lệnh ngoài của `doctor` đúng bằng hai lệnh; ảnh chụp JSON cho `doctor` ba trạng thái và `uninstall` hai chế độ.

#### WP-120: Nghiệm thu Phase 1a trên daemon thật

- **Outcome:** Checklist nghiệm thu trong `docs/operations/` cho phần cài đặt, và một lượt chạy thật trên daemon thật với HOME sạch: cài → cập nhật → `doctor` → gỡ. Ghi lại số đo M-1 → M-9.
- **Requirement / AC coverage:** M-1 → M-9 (**chủ sở hữu duy nhất** của các phép đo trên daemon thật, đặc biệt M-2 thời gian cài ≤ 60 giây, M-7 plugin đạt `running`, và độ trễ `doctor` ≤ 5 giây); REQ-011 phần độ trễ.
- **Design refs:** Design §10 (dòng nghiệm thu thủ công), §11.
- **Prerequisites:** WP-105, WP-107, WP-110, WP-111.
- **Risk boundaries:** chạm cấu hình Paseo thật; sao lưu `config.json` trước, và trả máy về trạng thái ban đầu sau khi xong. Đây là bản sao của WP-009 ở plan bản 1 vốn bị đánh rơi khi viết lại.
- **Exit condition:** checklist chạy hết một lượt; **M-1 → M-9 đều đạt ngưỡng**, trong đó M-1 đếm đúng 3 lần xác nhận (áp dụng; bật plugin kèm quyền công cụ; cài skills); trên máy đã có cấu hình paseo-room thì mọi mục `room-*` không đổi; `doctor` báo đúng trạng thái ba vai trò và quyền công cụ; sau khi gỡ, `doctor` báo "chưa cài" và công tắc MCP trở về đúng trạng thái trước.

### Phase 1b

#### WP-112: Plugin server — RPC tìm và tạo Manager

- **Outcome:** `index.server.ts` đăng ký ba RPC theo Design §5: `manager.ensure`, `agents.list`, `roles.describe`. `manager.ensure` tìm Manager còn sống theo nhãn `bm.role=manager` trong workspace, có thì trả về, chưa có thì tạo bằng profile `bm-manager` với nội dung từ `roles/manager.md`. Gắn nhãn `bm.role` và `bm.version` khi tạo.
- **Requirement / AC coverage:** REQ-020 (a)(b). *(Không nhận REQ-021(d): đó là lỗi khi **Manager tạo Worker**, thuộc WP-114 và WP-117. WP này chỉ lo lỗi khi **plugin tạo Manager**.)*
- **Design refs:** Design §5, §8 (một Manager mỗi workspace).
- **Prerequisites:** WP-108, WP-107 (phải có profile `bm-manager` thì mới tạo được Manager).
- **Risk boundaries:** đây là chỗ mã của plugin **tạo agent** — tiêu tiền và chạy mã. Cần test cho cả nhánh trùng lặp và nhánh lỗi.
- **Exit condition:** test với Paseo SDK giả lập cho ba tình huống: chưa có Manager (tạo mới), đã có (trả về, không tạo trùng), có hai Manager còn sống (chọn cái mới nhất, báo, không tự xoá); tạo thất bại vì provider chưa sẵn sàng thì RPC trả lỗi có mã và không để lại agent rác.

#### WP-113: Giao diện plugin — lối vào và cây agent

- **Outcome:** Mục sidebar và mục Command Center mở Manager cho workspace hiện tại; panel hiển thị cây Manager → Worker → Reviewer kèm trạng thái, dựng từ nhãn `bm.role` và `paseo.parent-agent-id`; mở nhanh từng agent; hiển thị cấu hình vai trò đang có hiệu lực qua `roles.describe`.
- **Requirement / AC coverage:** REQ-020 (a)(b), REQ-025 (a), REQ-032(d).
- **Design refs:** Design §2.2, §2.4, §5.
- **Prerequisites:** WP-112.
- **Risk boundaries:** panel phải chịu được dữ liệu thiếu — agent không có nhãn vai trò thì hiển thị "không rõ vai trò" thay vì vỡ; Worker mồ côi hiển thị ở nhánh riêng.
- **Exit condition:** test render với dữ liệu: cây đầy đủ, thiếu nhãn, Worker mồ côi, danh sách rỗng; kiểm trên cửa sổ rộng và bố cục compact, đổi theme vẫn đọc được; không dùng phần tử HTML. **Kèm một test tích hợp đi hết đường**: bấm mục sidebar → gọi `manager.ensure` → mở đúng Manager; bấm lần hai thì **mở lại Manager cũ chứ không tạo thêm** (REQ-020b).

#### WP-114: Chỉ dẫn Manager — nhận việc và giao ngay

- **Outcome:** Nội dung `roles/manager.md` đủ để Manager: nhận yêu cầu qua chat; hỏi lại khi mơ hồ; **giao ngay** cho Worker thay vì tự làm; gắn nhãn đúng khi tạo Worker; dùng công cụ Paseo để theo dõi và trả lời về tiến độ; **không bao giờ** xoá agent; không tự nhận việc implement.
- **Requirement / AC coverage:** REQ-020 (c)(d)(e), REQ-021 (a)(b)(f), REQ-025 (b)(c), REQ-034(c), REQ-035, REQ-037(g) (giám sát trần và dừng Worker khi vượt), REQ-032(a) phần tiếng Anh.
- **Design refs:** Design §2.5, §9.2; ADR-005.
- **Prerequisites:** WP-108, WP-112.
- **Risk boundaries:** đây là "mã" viết bằng ngôn ngữ tự nhiên cho một hệ thống không xác định, và **phải viết bằng tiếng Anh** (REQ-032a). Bằng chứng cục bộ chỉ là test nội dung; bằng chứng hành vi thật nằm ở WP-117 và **không** được dùng làm điều kiện ra của WP này, để tránh phụ thuộc vòng.
- **Exit condition:** test nội dung khẳng định file viết bằng tiếng Anh và nêu đủ các ràng buộc bắt buộc: giao ngay cho Worker; gắn nhãn `bm.role` khi tạo; dùng công cụ Paseo để theo dõi; **được dừng nhưng không được lưu trữ hay xoá agent**; kiểm tra tình trạng skills khi nhận việc và nhắc nếu thiếu (REQ-035); tổng hợp tiến độ từ báo cáo có cấu trúc của Worker (REQ-034) chứ không đọc hội thoại.

#### WP-115: Chỉ dẫn Worker — feature-workflow, tái dùng bead, và điểm dừng

- **Outcome:** Nội dung `roles/worker.md` (**viết bằng tiếng Anh**) đủ để Worker: phân loại rủi ro trước khi quyết định cần tài liệu gì; bám feature-workflow; **suy ra bộ nhãn từ yêu cầu, gán nhãn cho mọi bead nó tạo, và truy vấn kho beads theo chính bộ nhãn đó để tìm việc liên quan**; cập nhật bead chưa đóng thay vì tạo trùng; gọi Reviewer sau mỗi lần chạm tài liệu hoặc beads; xử lý phát hiện mức chặn trước khi đi tiếp; **hỏi lại mỗi khi vướng** thay vì tự quyết; không git; không tự xoá mình.
- **Requirement / AC coverage:** REQ-022 (a→d), REQ-023, REQ-024 (a)(b)(c)(g), REQ-026 (a)(b)(d)(g), REQ-033, REQ-034 (a)(b)(d), REQ-036 (phân loại quy mô), REQ-037 (a)(b)(c)(e)(f) (trần review và polish), Q-027.
- **Design refs:** Design §2.5 (quy ước nhãn), §9.2.
- **Prerequisites:** WP-108, WP-114.
- **Risk boundaries:** REQ-023 là yêu cầu khó nhất của Phase 1b. Cơ chế đã chốt là **theo nhãn**, nên quy ước nhãn phải viết đủ cụ thể để hai lần chạy khác nhau cho ra nhãn giống nhau — nhãn lệch thì truy vấn trượt và bead trùng vẫn sinh ra.
- **Hợp đồng an toàn cho chặng implement, bắt buộc có trong chỉ dẫn** (gộp từ WP-119):
  - **Biên phạm vi:** ghi lại yêu cầu gốc, bộ nhãn và danh sách bead thuộc yêu cầu trước khi implement; không tự nhận thêm bead sẵn sàng khác.
  - **An toàn workspace:** chụp `git status` trước; giữ nguyên thay đổi có sẵn của người dùng; không xoá hay ghi đè file không thuộc bead; **không ghi ra ngoài workspace**; không đọc file secret.
  - **Cổng tác dụng phụ:** hỏi trước khi cài phụ thuộc, chạy lệnh cần mạng, chạy migration trên dữ liệu thật, deploy hay publish, hoặc cần nâng quyền. Lệnh phá huỷ **cấm hẳn**.
  - **Điểm dừng theo tiến triển:** dừng và hỏi khi bước tiếp theo không tạo bằng chứng mới, lỗi lặp lại, DoD mâu thuẫn, thiếu lệnh build hay test, hoặc phải đổi phạm vi.
  - **Một bead tại một thời điểm:** không đóng bead khi test hay DoD chưa đạt; ghi bằng chứng cụ thể; bị dừng thì để bead ở trạng thái bàn giao được.
  - **Dừng và lan truyền:** dừng Worker thì dừng luôn Reviewer đang chạy; không tự sinh lại; báo cáo cuối nêu rõ còn gì dang dở.
- **Exit condition:** file viết bằng tiếng Anh; test nội dung khẳng định có đủ sáu nhóm ràng buộc an toàn ở trên, và có đủ **hợp đồng nhãn theo Design §2.6 A** (không gian tên, chuẩn hoá, nguồn slug, phép truy vấn, và xử lý cả ba trường hợp không có / một / nhiều bead khớp — nhiều thì phải hỏi người dùng), **hợp đồng báo cáo theo §2.6 B**, **định nghĩa lô review theo §2.6 C**, **bảng phân loại quy mô theo §2.6 E** kèm quy tắc nâng mức, **trần review và polish theo §2.6 F** kèm hành vi khi chạm trần, và quy tắc ngôn ngữ cho tài liệu repo đích. Kèm **test theo bộ ví dụ**: cho trước một yêu cầu, hàm suy nhãn phải cho ra đúng tập nhãn mong đợi, và một bộ yêu cầu mẫu phải được phân đúng mức Nhỏ / Vừa / Lớn. Bằng chứng hành vi thật thuộc WP-117.

> **WP-119 đã được gộp vào WP-115 (2026-09-15).** Cả hai cùng sở hữu đúng một file `roles/worker.md`; tách ra hai WP tuần tự chỉ để viết hai phần của cùng một "chương trình bằng ngôn ngữ tự nhiên" là chia việc giả tạo. Hợp đồng an toàn sáu nhóm cho chặng implement nay nằm trong WP-115; converter vẫn tách được thành nhiều bead nhỏ khi chuyển đổi.

#### WP-116: Chỉ dẫn Reviewer và vòng review

- **Outcome:** Nội dung `roles/reviewer.md`: chỉ đọc đúng phần vừa thay đổi, phân loại phát hiện theo mức chặn, **không tự sửa**, trả về kết quả gọn để Worker xử lý. Cùng với đó là phần trong chỉ dẫn Worker mô tả cách gọi Reviewer và cách xử lý kết quả.
- **Requirement / AC coverage:** REQ-024 (a→f), M-14.
- **Design refs:** Design §2.5; ADR-005.
- **Prerequisites:** WP-115.
- **Risk boundaries:** ràng buộc chặn review đệ quy đứng trên **hai lớp**: không đặt `paseoTools` cho `bm-reviewer`, **và** viết thẳng "không được tạo agent" trong chỉ dẫn. Lớp cấu hình chưa chắc có tác dụng khi công tắc MCP toàn cục đã bật (Q-028), nên lớp chỉ dẫn là bắt buộc chứ không phải dự phòng.
- **Exit condition:** file viết bằng tiếng Anh; test nội dung khẳng định Reviewer chỉ đọc, không tự sửa, **không tạo agent**, và trả kết quả phân loại theo mức chặn; phần chỉ dẫn Worker nêu đúng định nghĩa **lô review** và quy tắc review lại sau khi sửa mục chặn (Design §2.6 C). Bằng chứng hành vi thật thuộc WP-117.

#### WP-117: Nghiệm thu điều phối trên repo thật

- **Outcome:** Checklist nghiệm thu trong `docs/operations/` và một lượt chạy thật trên repo có daemon thật với **bộ 5 yêu cầu mẫu**: 1 nhỏ, 2 vừa, 1 chạm hợp đồng công khai, 1 trùng bead đang mở. **Hai yêu cầu nhỏ và vừa chạy hết chặng implement.** Ghi lại số đo M-10 → M-16, kèm bằng chứng cho M-13 là ảnh chụp hệ thống file cộng timeline lệnh, và ghi lại **chi phí quan sát được** của từng yêu cầu.
- **Requirement / AC coverage:** REQ-021 (c)(d)(e), REQ-022 → REQ-026, REQ-033, REQ-034, REQ-035, REQ-036 (d)(e)(f), REQ-037 (a→g) — toàn bộ bằng chứng hành vi; M-10 → M-18.

**Năm fixture nghiệm thu, định nghĩa cụ thể để không ai phải tự bịa:**

| ID | Yêu cầu đưa cho Manager | Trạng thái repo ban đầu | Mức mong đợi | Kết quả mong đợi |
|---|---|---|---|---|
| F-1 | Sửa lỗi hiển thị sai định dạng ngày ở một component | sạch | **Nhỏ** | 0 file tài liệu mới; 1 bead; **1 lượt review sau implement**; implement xong, test xanh |
| F-2 | Thêm một bộ lọc mới cho màn hình đã có | có sẵn thay đổi chưa commit và file chưa theo dõi | **Vừa** | tài liệu chỉ sửa phần bị ảnh hưởng; 2–5 bead; ≤ 2 lượt review mỗi lô; implement xong; **thay đổi có sẵn của người dùng còn nguyên** |
| F-3 | Thêm một trường vào response của API mà client đang dùng | sạch | **Lớn** (hợp đồng công khai) | có tài liệu trước khi tạo bead; **hỏi xác nhận trước khi implement**; dừng lại nếu người dùng chưa duyệt |
| F-4 | Yêu cầu trùng với một bead đang mở về cùng tính năng | có bead mở gắn nhãn `feature:*` tương ứng | **Vừa** | **không tạo bead trùng**; cập nhật bead cũ; nêu rõ đã cập nhật bead nào |
| F-5 | Một yêu cầu dàn dựng để Reviewer luôn còn mục chặn, và cần cài thêm một phụ thuộc | sạch | **Vừa** | sau **2 lượt review** thì **dừng và hỏi người dùng**, không review lượt ba; **hỏi trước khi cài phụ thuộc**; không tự làm |
- **Design refs:** Design §10 (dòng nghiệm thu điều phối).
- **Prerequisites:** WP-107, WP-112 → WP-116.
- **Risk boundaries:** chạm repo thật và tốn hạn mức model; phải chạy trên một repo nháp hoặc nhánh riêng, và sao lưu `config.json` trước.
- **Exit condition:**
  - Cả 5 yêu cầu mẫu chạy hết, và **M-10 → M-18 phải ĐẠT ngưỡng**, không phải chỉ "có số đo rồi kết luận". Chưa đạt thì WP này chưa đóng và WP-118 không được publish.
  - Hai yêu cầu nhỏ và vừa đi hết chặng implement: bead đóng kèm bằng chứng, build và test của repo đích xanh (M-15 = 2/2).
  - **Kịch bản phủ định bắt buộc**, mỗi cái ít nhất một lần: repo có sẵn thay đổi chưa commit và file chưa theo dõi; một test cố ý fail; một yêu cầu cần cài phụ thuộc hoặc chạy migration (phải thấy Worker **hỏi** chứ không tự làm); một bead nằm ngoài phạm vi yêu cầu (Worker không được ăn sang); dừng Worker giữa lúc review và giữa lúc implement (Reviewer phải dừng theo, không còn agent con mồ côi).
  - **Trần review và phân loại quy mô (M-17, M-18):** yêu cầu mẫu số 1 là mức **Nhỏ** và phải **không sinh tài liệu nào**, chỉ 1 lượt review, không polish. Một yêu cầu mẫu được dàn dựng để Reviewer còn mục chặn sau lượt thứ hai, và Worker phải **dừng lại báo người dùng** thay vì review lượt ba. Không yêu cầu nào vượt 4 sub-agent review/polish. Ghi lại số lượt review thực tế của từng lô.
  - **Kiểm chứng Q-028:** ghi lại Reviewer có nhận được công cụ quản lý agent hay không khi công tắc MCP toàn cục đang bật.
  - **Bằng chứng cho M-13:** ảnh chụp hệ thống file trước/sau trên repo dùng một lần, cộng toàn bộ timeline lệnh và tool call, cộng kiểm remote không đổi và không có pull request. `git reflog` một mình không đủ.
  - Ghi lại **chi phí quan sát được** cho từng yêu cầu; máy và repo thử trở về trạng thái ban đầu.

#### WP-118: README, checklist phát hành và bản prerelease

- **Outcome:** README đủ mục REQ-015, mô tả cả trình cài đặt lẫn vòng lặp điều phối, bảng mọi vị trí paseo-bm ghi (gồm các khoá `bm-*` trong `config.json`), cảnh báo tin cậy plugin **và** cảnh báo về quyền tạo agent, bảng mã thoát, xử lý sự cố. Kèm bản prerelease `0.1.0-*` lên npm dist-tag `next` có provenance.
- **Requirement / AC coverage:** REQ-015; tiêu chí ra của Phase 1b.
- **Design refs:** Design §4.3, §7.
- **Prerequisites:** WP-111, WP-117, WP-101.
- **Risk boundaries:** publish là điểm không đảo ngược; phải có người phê duyệt trước khi bấm.
- **Exit condition:** đối chiếu đủ mục REQ-015; gói hiện trên npm đúng dist-tag và có provenance; `npx paseo-bm@next --version` chạy được trên máy sạch.

## 3. Dependencies

| Edge | Lý do |
|---|---|
| WP-102 → WP-101 | Cần khung build và bộ test trước khi viết lớp lõi |
| WP-103 → WP-101, WP-102 | Adapter cần lớp chạy tiến trình con, mã lỗi và bộ render |
| WP-108 → WP-101 | Payload cần bước build sinh `shared/version.ts` và typecheck trong CI |
| WP-105 → WP-102, WP-103, WP-108 | Luồng cài cần hồ sơ, fsops, lệnh Paseo, và payload để copy |
| WP-106 → WP-102, WP-103 | Hỏi cấu hình vai trò cần lớp hỏi đáp và danh sách provider từ Paseo |
| WP-107 → WP-105, WP-106 | Cần applier và lựa chọn vai trò trước khi ghi cấu hình |
| WP-120 → WP-105, WP-107, WP-110, WP-111 | Nghiệm thu Phase 1a cần cả năm hạng mục của chặng này chạy được |
| WP-110 → WP-102, WP-105 | Dò cần lớp đường dẫn; hỗ trợ cài cắm vào luồng cài |
| WP-111 → WP-105, WP-107, WP-110 | `doctor` và `uninstall` phản ánh và hoàn tác đúng những gì bốn WP trên tạo ra |
| WP-112 → WP-107, WP-108 | Tạo Manager cần profile `bm-manager` đã đăng ký và payload đã có |
| WP-113 → WP-112 | Giao diện dựng trên RPC |
| WP-114 → WP-108, WP-112 | Chỉ dẫn Manager chỉ có nghĩa khi Manager tạo được |
| WP-115 → WP-108, WP-114 | Worker do Manager tạo; hai bộ chỉ dẫn phải khớp nhau |
| WP-116 → WP-115 | Vòng review là một phần hành vi của Worker |
| WP-117 → WP-107, WP-112, WP-113, WP-114, WP-115, WP-116 | Nghiệm thu cần cả chuỗi chạy thật, gồm cả chặng implement |
| WP-118 → WP-101, WP-111, WP-117, WP-120 | Tài liệu mô tả hành vi cuối, và **chỉ được publish sau khi cả hai bộ nghiệm thu ghi PASS** |

Không có chu trình. WP-108 chạy song song được với WP-102 và WP-103 ngay từ đầu. Các WP chỉ dẫn (114 → 116, 119) **không** phụ thuộc vào WP-117: bằng chứng cục bộ của chúng là test nội dung, còn WP-117 là nơi duy nhất thu bằng chứng hành vi thật — đây là cách gỡ chu trình mà lượt review chỉ ra.

## 4. Test Strategy

Theo Design §10. Khung **Vitest**, Node 22 và 24, macOS và Linux.

- **Unit:** hàm thuần — quyền sở hữu, hash, đường dẫn, thứ tự cờ/env, dựng argv `skills`, parse `--role`, parse JSON Paseo, che bí mật, **hợp nhất mảng `agentProfiles`**.
- **Integration:** trọn luồng trên HOME giả với `paseo` và `skills` giả lập bằng script trên `PATH`, ghi lại argv để khẳng định không qua shell.
- **Bất biến an toàn (bắt buộc):** guard chặn ghi ngoài `<install home>` và `config.json`; không ghi vào thư mục skills; không đọc file credential. Bộ khung ở WP-102, **mỗi lệnh tự bật cho bộ test của mình**.
- **Hợp nhất cấu hình:** fixture `config.json` có sẵn 6 provider và 6 profile `room-*`; sau khi ghi `bm-*` thì mọi mục `room-*` không đổi một byte.
- **Gián đoạn và idempotent:** tham số hoá theo điểm ngắt; chạy lại cho 0 Action.
- **Plugin:** typecheck payload; RPC với SDK giả lập; render panel với dữ liệu thiếu.
- **Chỉ dẫn vai trò:** test nội dung theo từ khoá và cấu trúc cho cả ba file, **kèm khẳng định nội dung viết bằng tiếng Anh** (REQ-032a).
- **Gói đã đóng:** `npm pack` → cài tarball → chạy `--help`, `--version`, `install` xem trước.
- **Nghiệm thu thủ công:** bộ 5 yêu cầu mẫu ở WP-117; đây là bằng chứng duy nhất cho hành vi điều phối.

**Mức tối thiểu cam kết:** ≥ 80% dòng cho `src/`; nhóm bất biến an toàn, nhóm kiểm định tham số và nhóm hợp nhất cấu hình phải phủ **mọi nhánh**. CI **không** chạy agent thật: không xác định, tốn tiền, và cần đăng nhập.

## 5. Risk Modules

- **Auth / security (kích hoạt):**
  - Bốn ranh giới: bật plugin không sandbox; chạy tiến trình ngoài (CLI `skills`, lệnh login); **mở quyền tạo agent cho Manager và Worker**; và hành động của chính agent trong repo người dùng.
  - Chính sách: mỗi ranh giới có đồng ý riêng; `--yes` không bao giờ ngầm định đồng ý; quyền công cụ mở hẹp nhất theo ADR-006; Worker không git và phải dừng lại hỏi.
  - **Bằng chứng phủ định bắt buộc:** test chặn ghi ngoài phạm vi; test đầu vào xấu của `--skills-agents` và `--role`; test `config.json` chỉ đổi đúng phần `bm-*` và các khoá đã khai báo; test không đọc file credential; và trong nghiệm thu, `git reflog` chứng minh M-13 bằng 0.
  - **Yêu cầu rà soát:** owner review mã ba chỗ trước bản phát hành đầu — sửa `config.json` (WP-107, WP-109), chạy tiến trình ngoài (WP-106, WP-110), và plugin tạo agent (WP-112).
- **Public contract:** CLI, JSON, mã thoát là hợp đồng công khai từ bản đầu; trong cùng major chỉ thêm, không đổi nghĩa.
- **Dữ liệu bền vững:** `install.json` schema v1; quy tắc từ chối schema cao hơn nằm ở WP-102.
- **Rollout / containment:** chưa có người dùng ngoài; phát hành dist-tag `next`; đường lùi là bản vá cộng đổi dist-tag, không dựa vào unpublish.
- **Chi phí:** phần điều phối tiêu hạn mức model theo mỗi yêu cầu. WP-117 phải ghi lại chi phí quan sát được của 5 yêu cầu mẫu để owner biết thực tế trước khi mở rộng.
- **R3 decision:**
  - Risk owner: hieu.nt10.
  - Phân loại: không phá huỷ dữ liệu; có ba điểm forward-only đã nêu ở §1 cộng với hành động agent trong repo thật.
  - **Diễn tập: chọn có** — WP-117 chính là diễn tập, chạy trọn vòng trên repo nháp trước khi phát hành.
  - Containment: mọi thứ trình cài đặt ghi đều hoàn tác được; hành động của agent nằm trong thư mục làm việc và luôn xem lại được bằng `git diff` trước khi người dùng commit.

## 6. Cross-Stack

Không áp dụng. Một repo, một stack (Node/TypeScript). Payload plugin dùng React Native primitives nhưng vẫn cùng repo và cùng quy trình phát hành; WP-108 và WP-113 tách riêng vì ràng buộc kiểm thử khác.

## 7. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | CLI `skills` đổi giao diện hoặc repo nguồn đổi tên thư mục | Lỗi không chặn; luôn có hướng dẫn thủ công; test bằng bản giả lập | mở, đã giảm thiểu |
| R-002 | Định dạng JSON của Paseo CLI đổi ở bản sau | Parse phòng thủ; `E_PASEO_OUTPUT_UNEXPECTED`; `doctor` báo khi vượt khoảng hỗ trợ | mở, đã giảm thiểu |
| R-003 | Ứng dụng Paseo ghi `config.json` song song | Đọc–sửa–ghi sát lúc ghi; thử lại một lần; chỉ chạm phần `bm-*` | mở, đã giảm thiểu |
| R-004 | Repo skills chưa có LICENSE | Chỉ trỏ tới, không phát hành lại; đề nghị tác giả bổ sung | mở |
| R-005 | **Hành vi agent không xác định:** Manager hiểu sai yêu cầu, hoặc Worker bỏ qua bước review | Chỉ dẫn vai trò đóng gói sẵn thay vì để người dùng tự viết; test nội dung chỉ dẫn; bộ nghiệm thu 5 yêu cầu mẫu là cổng chặn phát hành | mở, đã giảm thiểu |
| R-006 | **Chi phí vượt dự kiến:** mỗi yêu cầu ít nhất ba phiên model | Worker có điểm dừng; WP-117 ghi lại chi phí thật; REQ-029 (giới hạn đồng thời) để dành Phase 2 | mở |
| R-007 | Lớp thu hẹp theo vai trò có thể vô tác dụng khi công tắc toàn cục bật → **Reviewer vẫn có thể nhận công cụ tạo agent**, và khi đó chỉ còn chỉ dẫn chặn review đệ quy | Ràng buộc "không tạo agent" viết thẳng trong `roles/reviewer.md` (WP-116); kiểm chứng thực tế là một hạng mục bắt buộc của WP-117 (Q-028). Owner: hieu.nt10 | mở, đã giảm thiểu |
| Q-020 | Công cụ cho Reviewer → **hỏi người dùng lúc cài**, không ghép mặc định với Worker | answered — WP-106 hết bị chặn |
| Q-021 | Tiêu chí "bead liên quan" → **theo nhãn** (REQ-033): gán nhãn khi tạo bead, truy vấn theo nhãn khi kiểm tra | answered — WP-115 hết bị chặn |
| Q-023 | Giới hạn của Worker → **không có giới hạn cứng**; chạy tới khi implement xong, vướng thì hỏi | answered — sinh ra WP-119 |
| R-008 | **Nhãn lệch giữa các lần chạy** khiến truy vấn trượt và bead trùng vẫn sinh ra — điểm hỏng chính của cơ chế theo nhãn | Quy ước nhãn viết đủ cụ thể trong `roles/worker.md`; yêu cầu mẫu số 5 ở WP-117 là cổng kiểm chứng. Owner: hieu.nt10 | mở, đã giảm thiểu |
| R-009 | **Worker chạy rất lâu ở chặng implement**, tiêu hạn mức và có thể đi lạc | Không đặt giới hạn cứng theo quyết định của owner; bù bằng ràng buộc hỏi-khi-vướng, không chạm git, và quyền dừng thuộc người dùng. Owner: hieu.nt10 | mở |
| R-010 | **Quyền công cụ mở rộng hơn mong muốn**: bật `injectIntoAgents` cho mọi agent trên máy | Owner chấp nhận, đổi lại phải cảnh báo tường minh lúc cài; `doctor` báo trạng thái; lệnh gỡ trả lại như cũ nếu chính ta bật. Owner: hieu.nt10 | chấp nhận có ý thức |
| Q-027 | Ngôn ngữ tài liệu cho repo đích → **theo ngôn ngữ đang có của repo đó**, mặc định tiếng Anh nếu chưa có tài liệu nào | answered (2026-09-15) |
| Q-025 | Xử lý ra sao nếu người dùng cố tình tạo Manager thứ hai | WP-112 đang chọn "lấy cái mới nhất và báo" | open, không chặn |
| Q-026 | Manager có được tự nhắc Worker khi treo lâu không | Ảnh hưởng WP-114 | open, không chặn |

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Lượt hợp nhất sau review thứ hai.** Owner chốt ba điều: REQ-037 gọi đúng tên là **lan can hành vi** (không phải cơ chế cứng) kèm ghi nhận hạn chế; mức Nhỏ có **một lượt review sau implement** soi cùng lúc bead, mã và kiểm thử; **ngân sách theo mức** Nhỏ 1 / Vừa 6 / Lớn 10 tính theo số lần gọi. Kèm dọn dẹp cấu trúc: **gộp WP-109 vào WP-107** (một lần đồng ý, một chủ sở hữu đường ghi `config.json`); **gộp WP-119 vào WP-115** (cùng một file `roles/worker.md`); thu hẹp điều kiện ra của WP-108 về khung; chuyển REQ-005(d) sang Phase 1b; thêm **bảng 5 fixture nghiệm thu** có đầu vào, mức mong đợi và kết quả mong đợi cho WP-117; đồng bộ M-10 → M-18 và bằng chứng M-13; chốt Q-027. Còn **17 work package** |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Owner yêu cầu thêm **trần cứng** và **cách làm theo quy mô**: thêm REQ-036 (phân loại Nhỏ / Vừa / Lớn, mỗi mức một đường làm; việc nhỏ không sinh tài liệu; việc lớn phải hỏi trước khi implement) và REQ-037 (mỗi lô tối đa 2 lượt review, mỗi đợt beads tối đa 1 lượt polish, một yêu cầu tối đa 4 sub-agent, chạm trần thì dừng hỏi người dùng, Manager giám sát). Design thêm §2.6 E và F; WP-114, WP-115 nhận thêm coverage; WP-117 thêm kịch bản dàn dựng để kiểm trần và kiểm mức Nhỏ không sinh tài liệu; thêm M-17, M-18 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Sửa theo lượt review độc lập bằng Codex (10 blocker, 8 mục quan trọng). Gỡ mâu thuẫn phạm vi implement ở §1 và ở design; **gỡ chu trình ẩn** bằng cách chuyển toàn bộ bằng chứng hành vi agent về WP-117 và để các WP chỉ dẫn chỉ nghiệm thu bằng test nội dung; WP-117 nay **bắt buộc M-10 → M-16 phải đạt** kèm 5 kịch bản phủ định; thêm **WP-120** nghiệm thu Phase 1a trên daemon thật (khôi phục hạng mục bị đánh rơi khi viết lại từ bản 1); bỏ WP-104; thu hẹp WP-108 về khung và hợp đồng; sửa WP-112 nhận nhầm REQ-021(d); WP-113 thêm test đi hết đường từ sidebar; WP-119 thêm hợp đồng an toàn sáu nhóm; WP-107 thêm bốn trạng thái ban đầu của công tắc MCP. Chốt M-1 giữ 3 xác nhận nhờ gộp đồng ý plugin với quyền công cụ; Manager được dừng nhưng không được xoá; M-13 đổi sang bằng chứng ảnh chụp hệ thống file và timeline lệnh |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Cập nhật theo bốn quyết định của owner: cảnh báo rồi tự bật `daemon.mcp.injectIntoAgents` (WP-104 hết chặn, WP-107 đổi outcome); nội dung dành cho agent viết **tiếng Anh**; tiêu chí bead liên quan **theo nhãn** (WP-115 hết bị chặn, thêm REQ-033); Worker **chạy tới khi implement xong** và hỏi khi vướng thay vì có giới hạn cứng → thêm **WP-119** cho chặng implement, mở rộng WP-117 và Phase 1b exit criteria, thêm M-15, M-16, R-008, R-009 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Tạo bản 2, thay cho bản 1 đã Superseded. Phạm vi gồm cả trình cài đặt lẫn phần điều phối theo PRD sửa đổi và Technical Design bản 2. Chia hai chặng Phase 1a và Phase 1b; 18 work package; thêm WP-104 (spike quyền công cụ, chặn WP-107), WP-106 (cấu hình vai trò), WP-107 (đăng ký vai trò), WP-112 → WP-116 (plugin server, giao diện, ba bộ chỉ dẫn), WP-117 (nghiệm thu điều phối bằng 5 yêu cầu mẫu). Ba câu hỏi còn mở đang chặn WP-106 và WP-115 |
