# paseo-bm — Implementation Plan

| Trường | Giá trị |
|---|---|
| Status | **Superseded** — thay bằng [bản 2](paseo-bm-implementation-plan-v2.md) ngày 2026-09-15 |
| Plan-ready | PASS — 2026-09-15 — hieu.nt10 (cho phạm vi cũ, chỉ còn giá trị làm mốc đối chiếu) |
| Vì sao bị thay | PRD bổ sung phần điều phối (Beads Manager, Worker, Reviewer) — đây là giá trị cốt lõi của sản phẩm mà bản plan này không phủ. Phạm vi đổi quá lớn để dùng delta-change, nên plan được viết lại. Chín work package cũ phần lớn vẫn còn giá trị và được mang sang bản 2 |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Routing decision | [PRD §0](../../product/paseo-bm-prd.md#0-routing-decision) (canonical owner) |
| Source PRD | [paseo-bm PRD](../../product/paseo-bm-prd.md) |
| Source Technical Design | [paseo-bm Technical Design](../../design/paseo-bm.md) |
| Related ADRs | [ADR-001](../../adr/ADR-001-plugin-distribution.md) · [ADR-002](../../adr/ADR-002-install-ownership-model.md) · [ADR-003](../../adr/ADR-003-skills-delegation.md) · [ADR-004](../../adr/ADR-004-paseo-config-mutation.md) |
| Phase | Phase 1 MVP |

## 1. MVP-Lock

- **Trong phase này:** REQ-001 → REQ-015 của PRD; các chỉ số M-1 → M-9; kiến trúc và hợp đồng theo Technical Design §2 → §11; bốn quyết định ADR-001 → ADR-004.
- **Ngoài phase này** (dễ bị tưởng là có):
  - Tính năng nghiệp vụ của plugin: báo cáo tiến độ bead, tracker, điều phối implementation. Payload Phase 1 chỉ là khung hiển thị phiên bản (Design §2.3).
  - REQ-016 nhắc skills trong app, REQ-017 agent profiles, REQ-019 daemon từ xa.
  - Cài skills theo phạm vi project; đổi nguồn skills bằng cờ; ghim phiên bản skills.
  - Windows nguyên bản; Docker; `index.server.ts` và RPC của plugin.
  - Tự cập nhật, thông báo bản mới, telemetry.
- **Exit criteria:**
  1. Mọi AC của REQ-001 → REQ-015 đạt, có test tương ứng.
  2. CI xanh trên macOS và Linux, Node 22 và 24, **bao gồm smoke chạy trên gói npm đã đóng gói**.
  3. Demo trên HOME sạch đạt M-1 → M-9, có ghi lại kết quả theo checklist ở WP-009.
  4. Một bản prerelease `0.1.0-*` có trên npm kèm provenance, dist-tag `next`.
  5. README đạt REQ-015.
- **Default checkpoint posture:** mọi WP là thay đổi mã cục bộ, hoàn tác bằng git. Trên máy người dùng, mọi thứ paseo-bm ghi đều đảo ngược được: payload giữ lại mọi phiên bản, `config.json` có backup trước khi sửa, lệnh gỡ trả về trạng thái trước. **Hai điểm không đảo ngược được**, nêu rõ ở §5:
  - `npm publish` (npm không cho gỡ sau 72 giờ) → giảm thiểu bằng dist-tag `next` cho mọi bản Phase 1.
  - Bước chạy hộ CLI `skills`: paseo-bm không gỡ được skills đã cài → giảm thiểu bằng đồng ý rõ ràng và hướng dẫn tự gỡ bằng chính công cụ đó.

> Sau khi mục này được duyệt, phạm vi không được thêm nếu không có delta-change.

## 2. Work Packages

### WP-001: Khung dự án, đóng gói và phát hành

- **Outcome:** Repo chạy được đầu-cuối ở mức hạ tầng: TypeScript/ESM, build ra một file thực thi, `bin: paseo-bm`, các script `typecheck`/`lint`/`test`/`build`, CI trên macOS + Linux (Node 22, 24), smoke chạy trên gói `npm pack`, workflow phát hành dùng trusted publishing kèm provenance, không có script vòng đời npm.
- **Requirement / AC coverage:** NFR chuỗi cung ứng và tương thích (PRD §7); M-6. REQ-001c thuộc WP-002 (lớp dòng lệnh); WP này chỉ bảo đảm nhị phân chạy được từ gói đã đóng gói.
- **Design refs:** Design §2.2 (nền tảng), §9 (CI và smoke gói đã đóng).
- **Prerequisites:** none.
- **Sequencing:** đầu tiên; mọi WP khác build trên khung này.
- **Exit condition:** CI xanh trên cả hai OS; `npm pack` rồi cài tarball vào thư mục tạm, chạy `paseo-bm --help` và `--version` thành công; workflow phát hành chạy thử tới bước dry-run.

### WP-002: Nền tảng CLI — đường dẫn, hệ thống file, hồ sơ cài đặt, mô hình Action và báo cáo

- **Outcome:** Lớp lõi dùng chung cho mọi lệnh:
  - **Lớp dòng lệnh:** định tuyến lệnh con, đăng ký **đủ** cờ theo Design §4.2, plumbing cờ > env > mặc định, phát hiện TTY, `--help`/`--version`, mã 2 khi dùng sai; và một **giao diện hỏi đáp tiêm được** (test đưa câu trả lời theo kịch bản, chạy thật thì dùng thư viện prompt) để mọi AC cần đồng ý đều kiểm thử được.
  - **Sổ đăng ký mã lỗi/cảnh báo** duy nhất, liệt kê đủ cho Phase 1, mỗi mục có thông điệp và cách khắc phục (Design §4.4).
  - Giải đường dẫn; ghi atomic (tạm → `fsync` → `rename`) với quyền `0700`/`0600`; băm `sha256` và phân loại quyền sở hữu 5 trạng thái; đọc/ghi `install.json` schema v1 gồm `files[]`, `versions[]`, `backups[]`, `skills.*`; backup trước ghi đè; khoá tiến trình `.lock` có thu hồi khoá chết.
  - Mô hình `Action` cùng bộ render cho người và cho JSON; bảng mã thoát; che bí mật ở cả ba kênh output.
  - **Bộ khung chặn ghi**: lớp fs tiêm được cùng helper test làm **fail** khi có thao tác ghi ngoài `<install home>` và `<paseo home>/config.json`. WP này giao *bộ khung*; việc bật nó cho từng lệnh là điều kiện ra của WP-005, WP-007, WP-008.
- **Requirement / AC coverage:** REQ-001(c), REQ-004, REQ-008(a)(b)(c)(d), REQ-013(a)(b)(d), REQ-014; bộ khung cho REQ-008(e); nền cho REQ-009.
- **Design refs:** Design §3 (bố cục và schema), §3.3 (phân loại), §4.3 (mã thoát), §4.4 (JSON), §6 (quyền, chống thoát thư mục, che bí mật), §7 (atomic, khoá).
- **Prerequisites:** WP-001.
- **Sequencing:** ngay sau khung dự án; là đầu vào của mọi luồng lệnh.
- **Risk boundaries / decomposition hints:** đây là nơi đặt **bất biến an toàn** của cả sản phẩm. Lưu ý ranh giới: WP này chỉ giao **bộ khung** chặn ghi và test cho chính bộ khung; ba lệnh chưa tồn tại ở thời điểm này nên không thể nghiệm thu REQ-008e ở đây.
- **Exit condition:**
  - Mọi cờ trong Design §4.2 đã đăng ký; dùng sai trả mã 2; một test dùng bộ hỏi đáp theo kịch bản chạy trọn một lần cài tương tác giả lập.
  - Mọi mã trong sổ đăng ký đều có thông điệp và cách khắc phục; có test khẳng định không mã nào được đặt ngoài sổ.
  - Phân loại quyền sở hữu và ghi atomic có test cho cả 5 trạng thái; hồ sơ đọc/ghi được, từ chối `schemaVersion` cao hơn; render người và JSON có test ảnh chụp.
  - Che bí mật: `PASEO_PASSWORD`, `PASEO_DAEMON_PASSWORD` và token argv dạng mật khẩu bị che ở cả ba kênh, có test cho từng kênh.
  - **Không chạm credential:** test khẳng định trong `~/.paseo` chỉ đọc `config.json`, và không đọc file credential nào của Paseo hay agent (bằng chứng phủ định mà PRD §0 yêu cầu).
  - **Từ chối install home nguy hiểm** (bảng tham số: `$HOME`, thư mục cha của `$HOME`, `~/.paseo`, `~/.claude`, `~/.codex`) và **từ chối ghi xuyên symlink hay ra ngoài gốc cho phép**.
  - `.lock`: lệnh thứ hai đang chạy thật thì bị từ chối kèm thông điệp rõ; khoá của tiến trình đã chết thì thu hồi được.

### WP-003: Lớp tích hợp Paseo và preflight

- **Outcome:** Một lớp bọc duy nhất cho CLI `paseo`: `daemon status`, `plugin install|ls|logs|remove`, `daemon reload`, tất cả dùng `--json`, chạy tiến trình con không qua shell, có timeout, parse phòng thủ và mã lỗi ổn định. Kèm preflight kiểm tra OS, Node, có CLI, daemon chạy, `cliVersion` khớp `daemonVersion`, phiên bản `>=0.8.0`, quyền ghi thư mục đích; và bước dò beads CLI ở mức cảnh báo.
- **Requirement / AC coverage:** REQ-002; phần gọi Paseo của REQ-005.
- **Design refs:** Design §5 (bảng tích hợp), §4.3 (mã 3), §8.2 (bảng lỗi); ADR-004 (chỉ dùng CLI, phân biệt `enabled` với `status`).
- **Prerequisites:** WP-001, WP-002.
- **Sequencing:** trước mọi luồng ghi, vì preflight là cổng chặn.
- **Risk boundaries / decomposition hints:** phụ thuộc định dạng output của bên ngoài — cần test với CLI giả lập cho cả JSON đúng, JSON lạ, lỗi, và timeout.
- **Exit condition:** mọi nhánh preflight thất bại đều dừng trước khi ghi, trả mã 3 và thông điệp có cách khắc phục; adapter có test cho JSON hợp lệ, sai hình dạng, mã thoát khác 0 và treo; **timeout đúng con số đã chốt ở Design §7** — mỗi lời gọi 15 giây, có test với CLI giả lập treo vĩnh viễn.

### WP-004: Payload plugin Phase 1

- **Outcome:** Thư mục `plugin/` gồm `paseo-plugin.json` (`id: paseo-bm`, `requirements.paseo: ">=0.8.0"`), `index.client.tsx` đăng ký một sidebar surface và một Command Center item, `client/overview.tsx` hiển thị tên plugin và phiên bản; `shared/version.ts` được sinh lúc build; `tsconfig.json`. Typecheck payload nằm trong CI. Không có server entry, không RPC, không `node_modules`. **Surface chỉ dùng dữ liệu có sẵn lúc build** — client entry không đọc được hệ thống file, và ghi thêm dữ liệu vào payload sau khi băm sẽ làm hash lệch (Design §2.3); đường dẫn cài đặt và tình trạng skills chỉ nằm ở output của CLI.
- **Requirement / AC coverage:** REQ-005(d).
- **Design refs:** Design §2.3; ADR-001 (payload đi kèm gói, không kèm phụ thuộc).
- **Prerequisites:** WP-001.
- **Sequencing:** song song được với WP-002 và WP-003.
- **Risk boundaries / decomposition hints:** ràng buộc riêng của Paseo client: chỉ dùng primitive React Native, lấy màu từ `theme.colors`, kiểm tra bố cục compact. Đây là lý do WP này tách khỏi phần CLI.
- **Exit condition:** `npm run typecheck` của payload xanh; cài thủ công lên daemon thật đạt `status: "running"`; surface hiển thị đúng phiên bản trên cả giao diện rộng và compact.

### WP-005: Luồng cài và cập nhật

- **Outcome:** Lệnh `install` chạy đúng chuỗi preflight → planner → xem trước → xác nhận → applier, mặc định chỉ xem trước và cần `--apply` mới ghi; wizard khi có TTY, chỉ xem trước khi không có TTY; copy payload sang `plugin/<version>/` theo kiểu cài bên cạnh; đăng ký plugin qua WP-003; chốt hồ sơ gồm `files[]` và `versions[]`; nhận diện cài mới, cập nhật, hạ cấp (phải xác nhận rõ); dọn payload dở dang; bảo đảm chạy lại là 0 Action.
- **Requirement / AC coverage:** REQ-001(a)(b), REQ-003, REQ-005(a)(c), REQ-009, REQ-010(a)(b)(c), REQ-008 (áp dụng quy tắc xung đột trong luồng thật, kể cả REQ-008e cho lệnh này). REQ-005(b) — plugin đạt `status: "running"` — chỉ nghiệm thu được sau khi công tắc bật, nên thuộc WP-006.

**Phạm vi thực tế của 5 trạng thái quyền sở hữu** (phải viết rõ, nếu không sẽ có bead cho một nhánh không bao giờ chạy tới): vì nâng cấp luôn copy vào `plugin/<version mới>/`, mọi đích đều là `missing` → tạo mới, **không có ghi đè và không có câu hỏi giữ/ghi đè khi nâng cấp**. `user-modified`, `outdated`, `conflict`, `--force` và backup-trước-ghi-đè chỉ xảy ra khi: cài lại **cùng phiên bản**, sửa chữa file bị xoá hay bị sửa trong thư mục phiên bản đang hoạt động, hoặc với chính `install.json`. File người dùng đã sửa trong thư mục phiên bản **cũ** được để nguyên, liệt kê trong tóm tắt, và `--prune` không xoá. Journey J-2 bước 3 của PRD vì vậy là kịch bản "sửa chữa cùng phiên bản".
- **Design refs:** Design §8.1 (luồng và thứ tự đã kiểm chứng), §8.2 (lỗi), §2.1 (planner không ghi, applier không quyết định), §11 (hạ cấp).
- **Prerequisites:** WP-002, WP-003, WP-004.
- **Sequencing:** sau khi ba WP nền xong; là khung để WP-006 và WP-007 cắm vào.
- **Risk boundaries / decomposition hints:** WP này chứa ranh giới "trạng thái bền vững": payload trên đĩa, hồ sơ, và đăng ký phía Paseo phải nhất quán sau mọi điểm ngắt. Cần test gián đoạn theo từng bước.
- **Exit condition:**
  - Chạy `install --apply` hai lần cho 0 Action, không hỏi xác nhận, không đề nghị cài skills, không file nào đổi thời điểm sửa.
  - Giết tiến trình ở từng bước rồi chạy lại đều về trạng thái nhất quán; bản xem trước và bản áp dụng sinh ra cùng danh sách Action.
  - **Không có TTY và không có `--apply`:** in bản xem trước, trả **mã 6**, và bộ khung chặn ghi ghi nhận **0 thao tác ghi**.
  - Có test cho cả hai nhánh của phạm vi 5 trạng thái ở trên: nâng cấp (không ghi đè, không hỏi) và cài lại cùng phiên bản có file bị sửa (hỏi, backup, `--force`).
  - **Bộ khung chặn ghi được bật cho bộ test tích hợp của lệnh này và xanh** (REQ-008e).
  - `install --apply` với daemon giả lập hoàn tất dưới **20 giây** trong CI; con số trên daemon thật được ghi ở checklist WP-009 (M-2).

### WP-006: Công tắc `pluginsEnabled` và cơ chế đồng ý

- **Outcome:** Sau khi đăng ký plugin, nếu công tắc đang tắt thì hiện cảnh báo tin cậy và xin đồng ý; ở chế độ không tương tác cần `--enable-plugins` riêng, `--yes` không tính. Khi được đồng ý: backup `config.json`, đọc–sửa–ghi đúng một trường gốc, `daemon reload --json`, kiểm tra `appliedPaths`, poll `plugin ls` tới khi `status: "running"` có giới hạn thời gian; reload lỗi thì khôi phục backup và reload lại. Ghi nhận ai bật công tắc vào hồ sơ. Từ chối thì vẫn hoàn tất phần còn lại và trả mã 4 ở chế độ không tương tác.
- **Requirement / AC coverage:** REQ-006 (a→e), REQ-010(d); phần `status` của REQ-005(b).
- **Design refs:** Design §8.1 (đoạn kiểm chứng Q-017), §6 (ranh giới tin cậy 1); ADR-004 toàn bộ, gồm mục "Đã kiểm chứng".
- **Prerequisites:** WP-005.
- **Sequencing:** ngay sau luồng cài, vì nó là một bước trong luồng đó.
- **Risk boundaries / decomposition hints:** đây là **chỗ duy nhất paseo-bm ghi vào file của người khác**, nên có miền bằng chứng và miền hoàn tác riêng: backup, khôi phục, và test cho tình huống ghi song song.
- **Exit condition:** năm kịch bản đều có test với daemon giả lập: công tắc đã bật; tắt và đồng ý; tắt và từ chối (chế độ không tương tác trả mã 4); reload thất bại (khôi phục backup); và **ghi song song** — `config.json` bị bên thứ ba sửa giữa lúc đọc và lúc `rename` thì đúng **một** lần đọc lại rồi thử lại, lệch lần nữa thì dừng với `E_CONFIG_CONCURRENT_WRITE` và để file nguyên như bên thứ ba đã ghi. Trường hợp đồng ý phải chứng minh mọi khoá khác của `config.json` không đổi, và plugin đạt `status: "running"` trong hạn 30 giây (REQ-005b, M-7).

### WP-007: Skills — dò và hỗ trợ cài

- **Outcome:** Dò 5 skill bắt buộc trong `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, tôn trọng `CLAUDE_CONFIG_DIR` và `CODEX_HOME`, đi theo symlink, chỉ đọc. Báo cáo theo từng agent. Khi thiếu: hiển thị argv đã dựng sẵn với danh sách agent mặc định `claude,codex` **ngay trong câu hỏi đồng ý** (sửa danh sách là một thao tác tuỳ chọn, không phải câu hỏi riêng — giữ đúng ngân sách 3 lần xác nhận của M-1), rồi chạy CLI `skills` ở chế độ symlink, dò lại và báo trước/sau. Từ chối thì in hướng dẫn thủ công và ghi nhớ; `--ask-skills-again` xoá ghi nhớ đó. Chế độ không tương tác cần `--install-skills`.
  - **Kiểm định `--skills-agents` chạy lúc phân tích tham số**, trước preflight và trước mọi thao tác ghi: sai định dạng → mã 2 với `E_BAD_SKILLS_AGENTS`, không ghi gì. Đây là lỗi cách dùng, khác hẳn với lỗi **lúc chạy** của bước skills (thiếu CLI, mã thoát khác 0, hết giờ, không mạng) — những lỗi đó không bao giờ đổi mã thoát.
  - Tiến trình con có hạn giờ 300 giây và cảnh báo khi 60 giây không có output; hết giờ thì bị giết và chỉ ghi cảnh báo.
  - Khi bật `--json`, output của tiến trình con đi ra **stderr** để stdout vẫn là đúng một tài liệu JSON.
- **Requirement / AC coverage:** REQ-007 (a→i); REQ-010(e) (bị ngắt trong lúc CLI `skills` đang chạy: paseo-bm không để lại trạng thái sai của riêng nó, báo rõ phần skills có thể dở dang kèm lệnh chạy lại); REQ-013(c) (output của tiến trình con không được phá vỡ JSON khi bật `--json`); M-8, M-9.
- **Design refs:** Design §5 (dòng CLI `skills`), §6 (ranh giới tin cậy 2 và kiểm định tham số), §9 (ma trận skills, kiểm định tham số); ADR-003 (gồm phần sửa ngày 2026-09-14).
- **Prerequisites:** WP-002, WP-005.
- **Sequencing:** sau khi luồng cài có chỗ cắm; phần dò dùng lại được ngay cho WP-008.
- **Risk boundaries / decomposition hints:** hai miền khác hẳn nhau — **dò** là đọc file, thuần tuý, offline; **hỗ trợ cài** là chạy tiến trình ngoài có ranh giới tin cậy. Bằng chứng cho hai phần không giống nhau.
- **Exit condition:**
  - Ma trận M-8 xanh (đủ, thiếu một phần, thiếu hết, symlink, đổi vị trí bằng env, agent chưa cài).
  - Kiểm định: đầu vào xấu (ký tự lạ, bắt đầu bằng `-`, trùng, quá 8 phần tử) bị từ chối ở mức mã 2 và không ghi gì; argv cuối cùng đúng hệt như đã in cho người dùng.
  - CLI `skills` giả lập **ngủ vĩnh viễn** bị giết đúng hạn, việc cài plugin vẫn báo thành công và mã thoát không đổi; nhánh thất bại của M-9 in được hướng dẫn thủ công.
  - `install --apply --json --install-skills` cho stdout parse được thành JSON trong khi CLI giả lập ghi ra cả hai luồng.
  - **SIGINT giữa lúc tiến trình con chạy (REQ-010e):** tín hiệu được chuyển cho tiến trình con, `install.json` vẫn hợp lệ, `.lock` được nhả, ghi `assistOutcome: "interrupted"` thay vì kết quả dò, và in lệnh chạy lại.
  - Lần cài tương tác theo đường thuận lợi dừng lại **đúng 3 lần xác nhận** (khẳng định bằng số lần gọi của bộ hỏi đáp theo kịch bản) — đây là bằng chứng duy nhất cho M-1.
  - Bộ khung chặn ghi bật cho bộ test của lệnh này và xanh; không thao tác ghi nào vào thư mục skills đến từ chính paseo-bm.

### WP-008: `doctor`, `uninstall` và `prune`

- **Outcome:**
  - `doctor`: **không ghi gì, không chạm mạng**, và chỉ được gọi hai lệnh Paseo **chỉ-đọc** là `daemon status --json` và `plugin ls --json` — không có cách nào khác để biết trạng thái daemon và plugin; **không bao giờ** gọi CLI `skills`. Báo: thiếu, bị sửa, lỗi thời, plugin không `running`, công tắc tắt, daemon lệch phiên bản, thiếu beads CLI, tình trạng skills, **số lượng** phiên bản payload và backup đang giữ; mã thoát 0/1/2 đúng quy ước.
  - `uninstall`: xem trước rồi mới gỡ, chỉ gỡ theo hồ sơ, mặc định giữ file người dùng đã sửa (`--force` mới xoá), gọi `plugin remove`, tự xoá payload, `--restore-backups` thì khôi phục backup trước khi xoá, chỉ đề nghị tắt công tắc khi chính paseo-bm đã bật và không còn plugin nào khác, không đụng skills và không đụng khoá `plugins` của Paseo, xử lý được trường hợp daemon không chạy.
  - `--prune`: dọn payload cũ và backup, **chỉ khi người dùng yêu cầu**.
- **Requirement / AC coverage:** REQ-011, REQ-012 (a→h); phần Q-016 của Design.
- **Design refs:** Design §8.3 (gồm hai hành vi đã kiểm chứng của `plugin remove`), §4.1, §4.3, §7 (dọn rác).
- **Prerequisites:** WP-005, WP-006, WP-007.
- **Sequencing:** sau khi ba luồng ghi đã ổn định, vì `doctor` phản ánh đúng những gì chúng tạo ra.
- **Exit condition:**
  - **M-5 phát biểu chính xác:** sau `uninstall --apply` trên HOME giả, không có file nào bị người dùng sửa, daemon đang chạy, và người dùng chọn bỏ backup → `<install home>` không còn tồn tại và `config.json` không còn khoá nào do paseo-bm ghi (khoá `plugins: {}` do Paseo để lại không tính — Design §8.3).
  - Ba nhánh **được phép giữ lại**, mỗi nhánh một test: file người dùng đã sửa (REQ-012b, trừ khi `--force`); `backups/` khi người dùng chọn giữ; và `install.json` khi daemon không chạy (REQ-012h, giữ để lần sau hoàn tất).
  - `doctor` sau khi gỡ báo "chưa cài" và mã 0; có test cho bảng cho phép gọi lệnh ngoài của `doctor` đúng bằng `{paseo daemon status, paseo plugin ls}`.
  - Ảnh chụp JSON: `doctor --json` ở ba trạng thái (khoẻ, có sai lệch, chưa cài) và `uninstall --json` ở cả chế độ xem trước lẫn đã áp dụng.
  - `--prune` không bao giờ chạy ngầm; bộ khung chặn ghi bật cho bộ test của hai lệnh này và xanh.

### WP-009: README, checklist phát hành và nghiệm thu Phase 1

- **Outcome:** README đủ mục theo REQ-015, gồm bảng mọi vị trí paseo-bm ghi, khẳng định không tự ghi skills, tham chiếu `github.com/cuongntr/agent-skills` có ghi nhận tác giả, lưu ý skills dùng symlink nên các agent chung một bản, cảnh báo tin cậy plugin, cách cập nhật/gỡ, bảng mã thoát, xử lý sự cố. Kèm checklist nghiệm thu thủ công trên daemon thật trong `docs/operations/` và ghi lại kết quả đo M-1 → M-9.
- **Requirement / AC coverage:** REQ-015; exit criteria 3 và 4 của §1.
- **Design refs:** Design §9 (dòng "Thủ công, có checklist"), §10.
- **Prerequisites:** WP-005, WP-006, WP-007, WP-008; WP-001 cho phần phát hành.
- **Exit condition:** checklist chạy hết một lượt trên daemon thật, kết quả được ghi lại; bản prerelease có trên npm với dist-tag `next` và có provenance.

## 3. Dependencies

| Edge | Lý do |
|---|---|
| WP-002 → WP-001 | Cần khung build, kiểu dự án và bộ test trước khi viết lớp lõi |
| WP-003 → WP-001, WP-002 | Adapter cần lớp chạy tiến trình con, mã lỗi và bộ render đã có |
| WP-004 → WP-001 | Payload cần bước build sinh `shared/version.ts` và typecheck trong CI |
| WP-005 → WP-002, WP-003, WP-004 | Luồng cài cần hồ sơ và fsops (002), lệnh Paseo và preflight (003), và payload để copy (004) |
| WP-006 → WP-005 | Bật công tắc là một bước nằm trong luồng cài, và dùng chung applier cùng cơ chế backup |
| WP-007 → WP-002, WP-005 | Dò cần lớp đường dẫn và báo cáo; bước hỗ trợ cài cắm vào luồng cài |
| WP-008 → WP-005, WP-006, WP-007 | `doctor` và `uninstall` phản ánh và hoàn tác đúng những gì ba WP trên tạo ra |
| WP-009 → WP-005, WP-006, WP-007, WP-008, WP-001 | Tài liệu và nghiệm thu mô tả hành vi cuối, và cần workflow phát hành |

Không có chu trình. WP-004 chạy song song được với WP-002 và WP-003.

## 4. Test Strategy

Theo Design §9. Khung: **Vitest**, chạy trên Node 22 và 24, macOS và Linux.

- **Unit:** hàm thuần — phân loại quyền sở hữu, so hash, chuẩn hoá đường dẫn, thứ tự cờ/env, dựng argv cho CLI `skills`, parse JSON của Paseo, che bí mật.
- **Integration (phần lớn giá trị):** chạy trọn luồng trên **HOME giả** trong thư mục tạm, với `paseo` và `skills` **giả lập bằng script trên `PATH`**; script ghi lại argv nhận được để khẳng định không qua shell và đúng tham số.
- **Tương tác:** mọi AC cần đồng ý được kiểm thử qua **bộ hỏi đáp tiêm được** (câu trả lời theo kịch bản), không dựa vào TTY thật. Số lần hỏi cũng là thứ được khẳng định, vì đó là bằng chứng cho M-1.
- **Bất biến an toàn (bắt buộc, không được bỏ):** bọc lớp fs để test **fail** nếu có thao tác ghi ngoài install home và `config.json` — bộ khung thuộc WP-002, và **mỗi lệnh tự bật cho bộ test của mình**; kiểm tra riêng rằng không lệnh nào ghi vào thư mục skills; kiểm tra không đọc file credential.
- **Hiệu năng:** một khẳng định thời gian trong CI với daemon giả lập (`install --apply` dưới 20 giây). Con số thật của M-2 (≤ 60 giây) và độ trễ của `doctor` (≤ 5 giây) **chỉ đo trong checklist thủ công ở WP-009** và được ghi lại ở đó — CI không đo được số này một cách trung thực.
- **Gián đoạn và idempotent:** tham số hoá theo từng điểm ngắt trong luồng cài; chạy lại phải cho 0 Action.
- **Ma trận skills:** 6 bố cục theo M-8.
- **Gói đã đóng:** `npm pack` → cài tarball vào thư mục tạm → chạy `--help`, `--version`, `install` ở chế độ xem trước với môi trường giả.
- **Thủ công trước mỗi bản phát hành:** checklist trên daemon thật (WP-009); không đưa vào CI.

**Mức tối thiểu cam kết:** ≥ 80% dòng cho `src/`; riêng nhóm bất biến an toàn và nhóm kiểm định tham số phải phủ **mọi nhánh**. Không có test chạm daemon thật trong CI — giả lập cho tín hiệu ổn định hơn.

## 5. Risk Modules

- **Auth / security (kích hoạt):**
  - Hai ranh giới tin cậy: bật plugin không sandbox (WP-006) và chạy tiến trình ngoài (WP-007).
  - Chính sách đã chốt: đồng ý riêng cho từng ranh giới, `--yes` không bao giờ ngầm định đồng ý; nguồn skills cố định trong gói; tham số người dùng phải qua kiểm định của Design §6.
  - **Bằng chứng phủ định bắt buộc:** test chặn ghi ngoài phạm vi; test đầu vào xấu của danh sách agent; test chứng minh `config.json` chỉ đổi đúng một trường; **test chứng minh không đọc file credential** (trong `~/.paseo` chỉ đọc `config.json`) — đây là điều PRD §0 yêu cầu và bản plan đầu tiên đã bỏ sót.
  - **Yêu cầu rà soát:** WP-006 và WP-007 phải được owner review mã trước khi phát hành bản đầu tiên.
- **Public contract (kích hoạt, chưa có consumer):** CLI, JSON và mã thoát là hợp đồng công khai kể từ bản đầu. Chính sách: trong cùng major chỉ thêm trường, không đổi nghĩa; `schemaVersion` riêng cho JSON và cho hồ sơ cài đặt.
- **Dữ liệu bền vững (nhẹ):** `install.json` schema v1. Chưa cần migration ở bản đầu; đường nâng cấp và quy tắc từ chối schema cao hơn nằm trong WP-002.
- **Rollout / containment:** chưa có người dùng ngoài, nên rollout là phát hành npm với dist-tag `next`. Đường lùi: phát hành bản vá và đổi dist-tag; không dựa vào unpublish.
- **R3 decision:**
  - Risk owner: hieu.nt10.
  - Phân loại: không có dữ liệu bị phá huỷ, không rollout phối hợp. Có **hai điểm forward-only** đã nêu ở §1.
  - **Diễn tập: chọn có** — checklist thủ công trên daemon thật ở WP-009 chạy trọn vòng cài → cập nhật → gỡ trước khi publish, và đó cũng là bằng chứng cho M-1 → M-9.
  - Containment: mọi thứ paseo-bm ghi đều hoàn tác được bằng lệnh gỡ và backup; phần skills do CLI `skills` sở hữu, README ghi rõ cách tự gỡ.

## 6. Cross-Stack

Không áp dụng. Một repo, một stack (Node/TypeScript). Payload plugin dùng React Native primitives nhưng vẫn nằm trong repo này và đi cùng một quy trình phát hành; WP-004 đã tách riêng vì ràng buộc kiểm thử khác.

## 7. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | CLI `skills` đổi giao diện dòng lệnh hoặc repo nguồn đổi tên thư mục skill → luồng hỗ trợ cài gãy | Lỗi không chặn, luôn có hướng dẫn thủ công; test bằng bản giả lập; `doctor` phát hiện sớm. Owner: hieu.nt10 | mở, đã giảm thiểu |
| R-002 | Định dạng JSON của Paseo CLI đổi ở bản sau | Parse phòng thủ, chỉ đọc trường cần, mã lỗi riêng `E_PASEO_OUTPUT_UNEXPECTED`; `doctor` báo khi daemon vượt khoảng hỗ trợ. Owner: hieu.nt10 | mở, đã giảm thiểu |
| R-003 | Ứng dụng Paseo ghi `config.json` đúng lúc paseo-bm đang ghi | Đọc–sửa–ghi sát lúc ghi, so lại trước khi `rename`, thử lại một lần rồi dừng với thông điệp rõ (WP-006). Owner: hieu.nt10 | mở, đã giảm thiểu |
| R-004 | Repo skills mới có một commit, chưa có LICENSE | paseo-bm chỉ trỏ tới, không phát hành lại; README ghi rõ tác giả. Đề nghị tác giả bổ sung LICENSE. Owner: hieu.nt10 | mở |
| Q-011 | Cho đổi nguồn skills bằng cờ, hay cố định? | Design và ADR-003 đang chốt **cố định** ở Phase 1. Không chặn WP nào; nếu owner đổi ý thì ảnh hưởng WP-007 và cần bổ sung kiểm định nguồn | answered — cố định |
| Q-013 | Có ghim commit/nhánh khi gọi CLI `skills` không? | Khảo sát `skills --help` (bản 1.5.26) **không có cờ ghim ref**, nên Phase 1 lấy bản mới nhất và README nói rõ. Nếu sau này muốn ghim thì phải tự clone — trái ADR-003, cần ADR mới | answered (2026-09-15, theo việc owner duyệt tài liệu) — không ghim ở Phase 1 |

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Tạo bản Draft từ PRD và Technical Design đã chốt; 9 work package, 8 cạnh phụ thuộc, R3 chọn diễn tập thủ công trước khi phát hành |
| 2026-09-15 | hieu.nt10 | Owner duyệt PRD (Accepted), Technical Design (Active) và plan này. Chuyển plan sang **Active**, đóng dấu `Plan-ready: PASS`, đóng băng phạm vi Phase 1 MVP; Q-013 chốt "không ghim". Bốn câu hỏi mở cuối lượt review chưa được trả lời nên giữ nguyên như tài liệu: REQ-012e vẫn nằm trong phạm vi kèm cờ `--restore-backups`, không publish bản giữ tên sớm, WP-006 không tách. Từ đây mọi thay đổi phạm vi phải đi qua delta-change |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Lượt review (tự rà + một lượt độc lập). Sửa 5 blocker: mâu thuẫn mã thoát của REQ-001b (thêm mã 6), bất biến bất khả thi của `doctor`, nhánh ghi đè chết dưới bố cục cài-bên-cạnh, surface plugin lấn sang REQ-016 và không khả thi với client entry, REQ-010e không có WP nào nhận. Sửa các mục quan trọng: tách quyền sở hữu bộ khung chặn ghi khỏi việc nghiệm thu từng lệnh, thêm lớp dòng lệnh và bộ hỏi đáp tiêm được vào WP-002, sổ đăng ký mã lỗi, số timeout cụ thể, giữ stdout sạch khi `--json`, đặt tên ba cờ còn thiếu, phát biểu lại M-5 kèm ba nhánh được phép giữ, bổ sung kịch bản ghi song song, bằng chứng phủ định về credential, và khẳng định đúng 3 lần xác nhận cho M-1 |
