# Checklist nghiệm thu trình cài đặt trên daemon thật — paseo-bm

| Trường | Giá trị |
|---|---|
| Status | Active — nghiệm thu vòng đời cài / chạy lại / cập nhật / gỡ của trình cài |
| Áp dụng cho | `paseo-bm` `0.3.0`; Paseo CLI/daemon 0.8.0 trở lên (gồm 0.9.2, bản không còn `cliVersion` trong `daemon status --json`) |
| Liên quan | [PRD M-1 → M-9](../product/paseo-bm-prd.md#2-mục-tiêu--chỉ-số-thành-công) · [Design §9.1, §10](../design/paseo-bm.md) · [ADR-006](../adr/ADR-006-role-registration.md) |
| Nguồn gốc | Soạn cho nghiệm thu Phase 1a (`bm-wp-120-b2e.1.1`, lượt đạt 2026-09-15); giữ làm checklist hiện hành cho trình cài |

Tài liệu này mô tả **cách chạy và cách chấm**; nó không chứa số đo. Mỗi lượt chạy chép mục 9 và mục 10 sang một biên bản riêng. Ngưỡng M-1 → M-9 lấy nguyên văn từ PRD; checklist không đặt ngưỡng mới. Nên chạy khi một bản phát hành đổi trình cài (`src/`) hoặc khi lên một phiên bản Paseo mới.

## 1. Phạm vi và nguyên tắc

- Chuỗi chạy: **cài lần đầu → chạy lại cùng phiên bản → `doctor` → cập nhật lên phiên bản mới hơn → `doctor` → gỡ → trả máy về trạng thái ban đầu**, trên **daemon Paseo thật** với **HOME sạch** cho paseo-bm.
- "HOME sạch" nghĩa là paseo-bm, thư mục skills và cache npm của lượt chạy nằm trong một `HOME` tạm, còn `PASEO_HOME` vẫn trỏ vào `~/.paseo` thật để dùng daemon thật. Nhờ vậy skills do CLI `skills` cài không đổ vào thư mục skills thật của bạn.
- Lượt chạy **sửa `~/.paseo/config.json` thật**, đăng ký plugin `paseo-bm` và bật hai công tắc khi bạn đồng ý. Bước 3 backup trước; bước 8 trả về trạng thái ban đầu.
- Không chạy `paseo daemon restart` hay `stop`.
- Gặp tình huống checklist không lường trước: **dừng và ghi lại**, không tự ứng biến.

## 2. Biến dùng trong checklist

```bash
export RUN=~/bm-acceptance/$(date -u +%Y%m%d)/install
export EVID=$RUN/evidence
export REAL_PASEO_HOME="$HOME/.paseo"
export CLEAN_HOME=$RUN/home                 # HOME sạch cho paseo-bm
export REPO=/Users/Shared/work/self/paseo-plugins/paseo-bm
# Chạy paseo-bm trong HOME sạch nhưng với daemon thật:
bm() { HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" npx --yes --package "$TARBALL" paseo-bm "$@"; }
# Lệnh TƯƠNG TÁC có ghi log: dùng `script`, KHÔNG dùng `| tee`.
bmlog() { local log="$1"; shift; script -q "$log" env HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" npx --yes --package "$TARBALL" paseo-bm "$@"; }
mkdir -p "$EVID" "$CLEAN_HOME"
# Mô phỏng máy đã có Claude Code và Codex: không có hai thư mục này thì paseo-bm
# (và CLI skills) coi hai agent là CHƯA CÀI và bỏ qua bước skills — M-9 không đo được.
mkdir -p "$CLEAN_HOME/.claude" "$CLEAN_HOME/.codex"
```

> **Bẫy đã gặp:** HOME sạch không có `.claude`/`.codex` thì lần cài đầu bỏ qua bước skills; lần chạy lại, các CLI provider mà Paseo gọi để liệt kê model tự tạo `~/.codex`, `~/.cache/opencode`… trong HOME tạm và install hỏi lại skills. Đó là hiện tượng của HOME tạm, không phải paseo-bm ghi ngoài phạm vi. Tạo sẵn hai thư mục trên trước bước 4.

> **Bẫy đã gặp:** `bm install 2>&1 | tee file` làm stdout không còn là terminal, nên paseo-bm coi là **không có TTY**: không hỏi gì, dùng vai trò mặc định và thoát mã 6; một lệnh `--apply` sau đó cài thật mà không có đồng ý. Mọi lệnh cần trả lời câu hỏi phải chạy qua `bmlog` (dùng `script -q`, giữ nguyên TTY mà vẫn ghi log).

## 3. Chuẩn bị và backup

- [ ] Ghi commit đang nghiệm thu: `git -C "$REPO" rev-parse --short HEAD > "$EVID/commit.txt"`.
- [ ] Ghi các run CI của commit đó (dùng cho M-6): `gh run list --commit "$(git -C "$REPO" rev-parse HEAD)" > "$EVID/ci-run.txt"` — cần một run `ci.yml` và một run diễn tập `release.yml` (`gh workflow run release.yml -f tag=v<version>` nếu chưa có).
- [ ] Ghi phiên bản Paseo: `paseo --version > "$EVID/paseo-version.txt"; paseo daemon status --json >> "$EVID/paseo-version.txt"`.
- [ ] Đóng gói bản v1: `cd "$REPO" && npm ci && npm pack --pack-destination "$RUN"`, rồi `export TARBALL=$RUN/paseo-bm-<version>.tgz` (`<version>` của `package.json`).
- [ ] **Backup cấu hình Paseo:** `cp "$REAL_PASEO_HOME/config.json" "$EVID/config.before.json"`.
- [ ] Ghi hai công tắc trước khi chạy:
  `jq '{pluginsEnabled: (if has("pluginsEnabled") then .pluginsEnabled else "ABSENT" end), injectIntoAgents: (if ((.daemon.mcp // {}) | has("injectIntoAgents")) then .daemon.mcp.injectIntoAgents else "ABSENT" end)}' "$EVID/config.before.json" > "$EVID/switches.before.json"`
  (không dùng `//` cho giá trị boolean: `false // "ABSENT"` ra `"ABSENT"`, sai nghĩa).
- [ ] Ghi các mục `room-*` hiện có:
  `jq -S '{providers: ((.agents.providers // {}) | with_entries(select(.key|startswith("room-")))), profiles: [(.daemon.agentProfiles // [])[] | select(.id|startswith("room-"))]}' "$EVID/config.before.json" > "$EVID/room.before.json"`.
  Nếu cả hai rỗng, ghi "không có mục room-* trên máy này" vào biên bản; phép kiểm room-* khi đó dựa vào test tự động `npm test -- role-registration` (fixture 6 provider + 6 profile `room-*`).
- [ ] Ghi danh sách plugin: `paseo plugin ls --json > "$EVID/plugins.before.json"`.
- [ ] **Kiểm tiền đề HOME sạch:** `HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" paseo daemon status --json | jq '{home, localDaemon, pid}'` phải cho `home` đúng bằng `$REAL_PASEO_HOME`, `localDaemon: "running"` và `pid` giống lần chạy bình thường. Nếu không, **dừng** — HOME sạch không dùng được với daemon này, cần quyết định lại cách chạy.
  - **Bẫy đã gặp khi soạn checklist (2026-09-15):** **không** viết `HOME="$CLEAN_HOME" PASEO_HOME="$HOME/.paseo" …` trên cùng một dòng — bash mở `$HOME` *sau* khi đã gán `HOME` mới, nên `PASEO_HOME` trỏ vào HOME tạm; Paseo CLI khi đó tạo một `.paseo` mới trong HOME tạm và báo `localDaemon: "stopped"`. Luôn dùng biến `REAL_PASEO_HOME` đã tính sẵn ở mục 2.
  - Kiểm chứng đọc-chỉ lúc soạn: với `REAL_PASEO_HOME` tính sẵn, `daemon status` báo `home` thật, `localDaemon: "running"`, không tạo file nào trong HOME tạm và không đổi mtime file trong `~/.paseo`.
- [ ] Không còn agent `bm-*` nào đang chạy khi cài, cập nhật hay gỡ (`paseo ls`): cài lại hay nạp lại plugin ngắt lượt của agent.
- [ ] Tạo mốc thời gian: `touch "$EVID/start.marker"`.

## 4. Cài lần đầu (M-1, M-7, M-9)

- [ ] Chạy **tương tác** và đo tổng thời gian cho biên bản (không dùng cho M-2 vì có thời gian người trả lời):
  `time bmlog "$EVID/install-1.log" install`
- [ ] **Đếm số lần xác nhận** (M-1): áp dụng; bật plugin kèm quyền công cụ agent (một câu hỏi cho cả hai); cài skills. Câu hỏi cấu hình vai trò (tên, provider, model) **không** tính là xác nhận. Thiếu `br`/`bv` thì lần chạy tương tác cài chúng theo xác nhận áp dụng, không thêm câu hỏi. Ghi từng câu theo thứ tự vào `$EVID/m1-prompts.txt`.
- [ ] Trả lời: đồng ý áp dụng; đồng ý câu cảnh báo tin cậy; chọn provider/model cho ba vai trò (ghi lại); đăng nhập provider nếu được mời; **đồng ý cài skills**.
- [ ] Mã thoát 0: `echo $?` ngay sau lệnh (hoặc đọc dòng "Exit code" trong log).
- [ ] **M-7:** `paseo plugin ls --json | tee "$EVID/plugins.after-install.json" | jq '.[] | select(.id=="paseo-bm") | .status'` → `"running"`. Kiểm `status`, **không** kiểm `enabled`.
- [ ] **M-9:** trước khi cài, `HOME` sạch không có skill nào. Sau bước cài skills:
  `bm doctor --json > "$EVID/doctor-after-install.json"; jq '.checks[] | select(.id|startswith("skills-"))' "$EVID/doctor-after-install.json"` → năm skill bắt buộc có mặt cho các agent đã chọn.
  Nếu CLI `skills` thất bại (mạng, lỗi CLI): log phải có hướng dẫn cài thủ công kèm đúng lệnh — ghi lại dòng đó; đây là nhánh đạt thứ hai của M-9.

## 5. Chạy lại cùng phiên bản (M-3) và `doctor`

- [ ] Ghi hash trước: `shasum -a 256 "$REAL_PASEO_HOME/config.json" > "$EVID/config.rerun-before.sha256"; find "$CLEAN_HOME/.paseo-bm" -type f -print0 | sort -z | xargs -0 shasum -a 256 > "$EVID/installhome.rerun-before.sha256"`.
- [ ] Chạy lại **tương tác**: `bmlog "$EVID/install-rerun.log" install` → **không có câu hỏi nào**, báo cáo toàn `skip`, mã 0.
- [ ] Chạy lại không tương tác: `bm install --apply --json > "$EVID/install-rerun.json"; jq '[.actions[] | select(.kind != "skip")] | length' "$EVID/install-rerun.json"` → `0`.
- [ ] Hash sau khớp hash trước cho `config.json` và mọi file trong install home ngoài `.lock`.
- [ ] **`doctor`** (độ trễ và trạng thái): `time bm doctor --json > "$EVID/doctor-1.json"` → mã 0, thời gian ≤ 5 giây; `jq -r '.checks[] | "\(.id) \(.severity)"' "$EVID/doctor-1.json"` cho `paseo-daemon ok`, `paseo-version ok`, `plugin-status ok`, `plugins-enabled ok`, `agent-tools ok`, `role-bm-manager ok`, `role-bm-worker ok`, `role-bm-reviewer ok`, `beads-cli ok`, `beads-viewer ok`.

## 6. Cập nhật lên phiên bản mới hơn (M-2)

- [ ] Dựng bản v2 **ngoài repo**, không đổi repo. `<version v2>` phải lớn hơn v1 và giữ minor (một test ghim minor của payload), ví dụ v1 `0.3.0` → v2 `0.3.1-acc.0`; `npm pack` chạy `prepack` → build nên payload trong tarball mang đúng `<version v2>`:
  ```bash
  rm -rf "$RUN/v2src" && git clone -q "$REPO" "$RUN/v2src" && cd "$RUN/v2src"
  npm ci && npm version <version v2> --no-git-tag-version && npm pack --pack-destination "$RUN"
  export TARBALL=$RUN/paseo-bm-<version v2>.tgz
  ```
- [ ] **M-2 — thời gian cài phần plugin**, không tính bước skills, không có thời gian người trả lời:
  `/usr/bin/time -p bash -c 'HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" npx --yes --package "$TARBALL" paseo-bm install --apply --yes --skip-skills-check --json' > "$EVID/update.json" 2> "$EVID/update.time"`
  Chạy `npx` một lần trước với `--version` để gói đã được tải; số đo chỉ tính từ lúc `npx` đã có gói. Ngưỡng: `real` ≤ 60 giây.
- [ ] Mã thoát 0; `jq '.result' "$EVID/update.json"` có `pluginState: "running"`.
- [ ] Cài bên cạnh: `ls "$CLEAN_HOME/.paseo-bm/plugin"` có cả thư mục v1 và v2; `jq '.versions' "$CLEAN_HOME/.paseo-bm/install.json"` có hai mục, bản mới `active: true`.
- [ ] Vai trò không bị hỏi lại và không bị ghi lại (`roles[]` giữ nguyên).
- [ ] `bm doctor --json > "$EVID/doctor-2.json"` → mã 0, `install-version ok`, ba `role-bm-*` ok, `agent-tools ok`.

## 7. Gỡ (M-5)

- [ ] Chạy **tương tác** (M-5 chỉ đạt được khi tương tác, vì bỏ backup và tắt lại `pluginsEnabled` chỉ được hỏi qua prompt): `bmlog "$EVID/uninstall.log" uninstall --apply`.
- [ ] Trả lời: **bỏ backup**; **tắt lại** `pluginsEnabled` nếu được đề nghị (chỉ được đề nghị khi chính paseo-bm đã bật và không còn plugin nào khác).
- [ ] Mã thoát 0.
- [ ] **M-5 — không còn thứ do paseo-bm tạo:**
  - [ ] `test ! -e "$CLEAN_HOME/.paseo-bm"`.
  - [ ] `jq '[(.agents.providers // {}) | keys[] | select(startswith("bm-"))] + [(.daemon.agentProfiles // [])[] | .id | select(startswith("bm-"))]' "$REAL_PASEO_HOME/config.json"` → `[]`.
  - [ ] `paseo plugin ls --json | jq '[.[] | select(.id=="paseo-bm")] | length'` → `0`.
  - [ ] Không còn file tạm atomic do paseo-bm để lại: `ls -a "$REAL_PASEO_HOME" | grep -E '^\.config\.json\..*\.tmp$'` → rỗng.
  - [ ] Cấu hình khớp bản trước khi cài, bỏ qua khoá `plugins` mà Paseo để lại:
    `test -s "$EVID/config.before.json" && test -s "$REAL_PASEO_HOME/config.json" && diff <(jq -S 'del(.plugins)' "$EVID/config.before.json") <(jq -S 'del(.plugins)' "$REAL_PASEO_HOME/config.json")` → rỗng, mã 0. (Luôn kèm `test -s`: nếu biến chưa đặt, cả hai `jq` đều lỗi, hai đầu vào đều rỗng và `diff` báo "giống nhau" — kết luận sai.)
  - [ ] Hai công tắc trở về đúng giá trị ở `switches.before.json` (chạy lại đúng lệnh `jq` ở bước 3 lên `config.json` hiện tại rồi `diff`).
  - [ ] `bm doctor --json > "$EVID/doctor-after-uninstall.json"` → `install-record` báo chưa cài, mã 0.
  - Skills do CLI `skills` cài **không** tính là thứ paseo-bm tạo (ADR-003); chúng nằm trong `HOME` sạch và bị xoá ở bước 8.
- [ ] **room-\* giữ nguyên từng byte:** chạy lại lệnh `jq` của bước 3 ra `room.after.json`, rồi `cmp "$EVID/room.before.json" "$EVID/room.after.json"`.

## 8. Trả máy về trạng thái ban đầu

- [ ] Nếu phép `diff` cấu hình ở bước 7 rỗng: **không** chép đè gì cả.
- [ ] Nếu không rỗng: **dừng**, lưu `cp "$REAL_PASEO_HOME/config.json" "$EVID/config.after.json"`, đối chiếu từng khác biệt với biên bản. Chỉ chép `config.before.json` đè lên khi chắc chắn khác biệt đều do lượt chạy gây ra và không có thay đổi hợp lệ nào khác phát sinh trong lúc chạy; ghi quyết định vào biên bản.
- [ ] Nếu plugin `paseo-bm` còn trong `paseo plugin ls`: `paseo plugin remove paseo-bm`.
- [ ] Xoá HOME sạch và bản dựng tạm: `rm -rf "$CLEAN_HOME" "$RUN/v2src" "$RUN"/paseo-bm-*.tgz` (giữ lại `$EVID` cho tới khi biên bản được commit).
- [ ] So lại `plugins.before.json` với `paseo plugin ls --json`.

## 9. Đối chiếu M-1 → M-9: một phép đo, một quy tắc đạt

| Chỉ số | Định nghĩa (PRD) | Phép đo duy nhất | Đạt khi | Ô bằng chứng |
|---|---|---|---|---|
| M-1 | Số thao tác để cài lần đầu | Đếm lệnh và lần xác nhận ở bước 4 | 1 lệnh và **đúng 3** xác nhận: áp dụng; bật plugin kèm quyền công cụ; cài skills | `install-1.log`, `m1-prompts.txt` |
| M-2 | Thời gian cài phần plugin, từ lúc `npx` đã có gói, chưa tính skills | `real` của lệnh cập nhật không tương tác ở bước 6 | `real` ≤ 60 giây | `update.time` |
| M-3 | Thay đổi khi chạy lại cùng phiên bản | Bước 5: số Action khác `skip` và so hash | `0` Action khác `skip`, không câu hỏi, hash `config.json` và install home không đổi | `install-rerun.log`, `install-rerun.json`, `*.rerun-before.sha256` |
| M-4 | Số lần ghi ngoài phạm vi sở hữu | Test tự động `npm test -- integration/install ownership` trên commit đang nghiệm thu (guard chặn ghi toàn tiến trình, không tự ghi thư mục skills, không ghi đè file người dùng đã sửa khi chưa đồng ý) | Tất cả xanh; trong lượt chạy thật không có lỗi ghi và room-* giữ nguyên | output test, `room.*.json` |
| M-5 | Thứ do paseo-bm tạo còn sót sau khi gỡ | Toàn bộ các mục kiểm ở bước 7 | Mọi mục kiểm đạt | `uninstall.log`, `doctor-after-uninstall.json`, output các lệnh bước 7 |
| M-6 | Tỉ lệ cài thành công trên ma trận hỗ trợ | Run CI của commit đang nghiệm thu: `ci.yml` (ubuntu, Node 22) và diễn tập `release.yml` (ubuntu, macOS × Node 24, gồm `smoke:packed` trên gói đã đóng gói). Ma trận chia hai workflow theo delta 20260921 | 3/3 job `success` | `ci-run.txt` + link run |
| M-7 | Plugin `running` sau khi cài khi đã đồng ý | `paseo plugin ls --json` sau bước 4 | `status` của `paseo-bm` là `running` | `plugins.after-install.json` |
| M-8 | Độ chính xác báo cáo skills | Test tự động `npm test -- skills-detect` (đủ, thiếu một phần, thiếu hết, symlink, đổi vị trí bằng biến môi trường) | Tất cả xanh | output test |
| M-9 | Máy thiếu skills, đồng ý hỗ trợ → đủ skills | Bước 4: `doctor` sau khi cài skills, hoặc log hướng dẫn thủ công khi CLI `skills` thất bại | Năm skill bắt buộc có mặt; **hoặc** CLI thất bại và log có hướng dẫn thủ công kèm lệnh | `doctor-after-install.json` hoặc `install-1.log` |

Kiểm bổ sung theo điều kiện ra của WP-120 (không phải chỉ số riêng):

| Kiểm | Phép đo | Đạt khi |
|---|---|---|
| `doctor` báo đủ ba vai trò và quyền công cụ | Bước 5 và 6 | `role-bm-manager`, `role-bm-worker`, `role-bm-reviewer`, `agent-tools` đều `ok` |
| Độ trễ `doctor` (REQ-011) | `time` ở bước 5 | ≤ 5 giây |
| room-* không đổi | `cmp` ở bước 7 | Giống hệt, hoặc ghi "không có trên máy" kèm test tự động xanh |
| Công tắc MCP về trạng thái trước | So `switches.before.json` ở bước 7 | Khớp |

## 10. Phiếu ghi biên bản

```markdown
### Lượt chạy Phase 1a — <ngày>

- Commit / run CI:
- Máy (OS, Paseo CLI/daemon, Node, npm):
- Phiên bản v1 / v2:
- Provider / model — Manager / Worker / Reviewer:
- Công tắc trước: pluginsEnabled = …, injectIntoAgents = …
- room-* trên máy: có (n provider, n profile) / không

| Chỉ số | Số đo | Đạt? | Ghi chú |
|---|---|---|---|
| M-1 | … xác nhận | | |
| M-2 | … giây | | |
| M-3 | … Action khác skip | | |
| M-4 | test … | | |
| M-5 | … mục sót | | |
| M-6 | …/3 job | | |
| M-7 | status … | | |
| M-8 | test … | | |
| M-9 | có đủ / hướng dẫn thủ công | | |

- doctor: ba vai trò …, quyền công cụ …, độ trễ … giây
- Công tắc sau khi gỡ: pluginsEnabled = …, injectIntoAgents = …
- Trả máy về trạng thái ban đầu: không cần chép đè / đã chép đè (lý do)
- Lệch so với checklist:
```

## 11. Hạn chế đã biết

- M-5 chỉ đạt khi gỡ **tương tác**: không có cờ để bỏ backup hay tắt lại `pluginsEnabled` khi không có TTY.
- File tạm atomic (`.config.json.*.tmp`, `.install.json.*.tmp`) có thể bị bỏ lại nếu tiến trình bị giết đúng lúc đổi tên; không cơ chế nào dọn chúng. Bước 7 kiểm để phát hiện, không để che.
- Trong HOME tạm, các CLI provider do Paseo gọi (Codex, OpenCode, bun) tự tạo thư mục của chúng (`.codex/tmp`, `.cache/opencode`, `Library/Caches/bun`…). Các thư mục này không do paseo-bm tạo và không tính vào M-4/M-5.
- M-2 đo trên lượt **cập nhật** không tương tác, vì lượt cài đầu tiên phải tương tác để đếm M-1; bản ghi thời gian CI (`install.timing`) là số đo bổ sung.
- Tiền đề HOME sạch (Paseo CLI tôn trọng `PASEO_HOME`, `paseo plugin install` chạy được dưới HOME tạm) đã đứng vững ở lượt nghiệm thu 2026-09-15 trên Paseo 0.8.0; với một phiên bản Paseo mới, bước kiểm tiền đề ở mục 3 là nơi phát hiện nếu nó đổi.

---

*Revision 2026-09-25: giữ làm checklist hiện hành cho trình cài (`0.3.0`, Paseo 0.8.0+): bỏ số hiệu cố định `0.1.0-alpha.*`, thêm các check `doctor` hiện có (`paseo-*`, `beads-*`), M-6 theo hai workflow hiện tại, ghi phiên bản Paseo. Tên file còn mang chữ `phase1a` vì lịch sử; đề xuất đổi tên ở bước sắp xếp lại `docs/`.*
