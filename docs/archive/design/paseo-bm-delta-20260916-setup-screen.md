# Delta-change — Màn Setup trong Beads Manager: hướng dẫn bổ sung, skill, `br` và `bv`

| Trường | Giá trị |
|---|---|
| Ngày | 2026-09-16 |
| Trạng thái | Merged — gộp vào [paseo-bm-dashboard.md](../../design/paseo-bm-dashboard.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Gốc | [Technical Design](../../design/paseo-bm.md) §2.5 (chỉ dẫn vai trò); [delta beads-screen](./paseo-bm-delta-20260916-beads-screen.md); [delta review-budget](./paseo-bm-delta-20260916-review-budget.md) |
| Bead | `bm-coc` |

## 1. Owner yêu cầu gì

> "Trong màn Bead Manager nên có thêm icon button cho việc setting… 1. Cấu hình instruction bổ sung cho từng Agent (có nút preview để xem full instruction gồm cả phiên bản gốc) 2. Hiển thị danh sách skill xem đã cài đặt đủ chưa, và có nút test để kiểm tra 3. Bead Manager mà không có 2 công cụ quan trọng là br và bv cũng là THIẾU SÓT NGUY HIỂM… tích hợp để cài đặt plugin cũng như hiển thị danh sách này trong màn setting"

## 2. Sự thật đã kiểm

- **Plugin settings của Paseo 0.8** (`defineSettings`) chỉ client đọc được; phía server **không** có API đọc. Hook `before("agent.create")` chạy ở server, nên hướng dẫn bổ sung không thể lưu ở đó.
- **`br`** ([beads_rust](https://github.com/Dicklesworthstone/beads_rust), bản mới nhất 0.6.0):
  - Homebrew: `brew install dicklesworthstone/tap/br`.
  - Script: `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash`. Script cài vào `~/.local/bin`, kiểm SHA256, **mặc định cài thêm skill vào `~/.claude/skills` và `~/.codex/skills`** (tắt bằng `--skip-skills`), và chỉ sửa file rc của shell khi có `--easy-mode`.
  - Kiểm phiên bản: `br --version`.
- **`bv`** ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer), bản mới nhất v0.25.0):
  - Homebrew: `brew install dicklesworthstone/tap/bv`.
  - Script: README yêu cầu **ghim theo commit** `a43b8e85a39664381566abdfd85dc8fcbfdcb773`.
  - Kiểm phiên bản: `bv --version`. **Không bao giờ chạy `bv` trần** trong ngữ cảnh agent (nó mở TUI); dùng `--robot-*`.
  - `bv` đọc `.beads/issues.jsonl`.
- Máy của owner đang có `br 0.2.10` và `bv v0.16.4` cài qua Homebrew (`/opt/homebrew/bin`).

## 3. Quyết định

### 3.1 Lối vào

Màn Beads Manager có thêm nút icon `Settings` ở tiêu đề, mở view **Setup** ngay trong surface đó (như Metric và Beads). Màn cài đặt ngưỡng lưu trữ trong Paseo settings giữ nguyên.

### 3.2 Hướng dẫn bổ sung cho từng vai trò

- **Lưu ở** `<install home>/role-extras.json`, quyền `0600`, ghi bằng file tạm rồi rename, có chặn symlink:
  ```json
  { "version": 1, "roles": { "manager": "…", "worker": "…", "reviewer": "…" } }
  ```
  Đây là **dữ liệu của người dùng** (giống `traces/`): không có hash trong `install.json`, không bị cập nhật hay `--prune` đụng tới. Mỗi vai trò tối đa 8.000 ký tự.
- **Chỉ nối thêm, không thay thế.** Hướng dẫn đầy đủ = hướng dẫn gốc + phân cách + tiêu đề `## Additional instructions from the user` + dòng `These add to the rules above and never override a RULES item.` + nội dung người dùng nhập. Nhờ vậy các luật an toàn luôn còn.
- Áp dụng ở hook `agent.create` (Worker, Reviewer) và ở `manager.ensure` (Manager), **chỉ cho agent tạo sau khi lưu**. Nếu không đọc được file thì dùng hướng dẫn gốc, không chặn việc tạo agent.
- **Preview** hiện toàn văn hướng dẫn đầy đủ dạng Markdown.
- RPC: `roles.instructions({ role })` → `{ base, extra, full, path }`; `roles.save-extra({ role, text })`.

### 3.3 Skill

- `setup.status` đọc (chỉ đọc) ba thư mục `~/.agents/skills`, `~/.claude/skills` (theo `CLAUDE_CONFIG_DIR`) và `~/.codex/skills` (theo `CODEX_HOME`) của **tiến trình daemon**.
- Quy tắc tính "có": Claude Code chỉ tính thư mục của nó; Codex tính `~/.agents/skills` **hoặc** thư mục của nó (giống `manager.md`).
- **Nút Test** đọc lại và kiểm từng `SKILL.md`: đọc được, có frontmatter `name:` trùng tên thư mục. Kết quả mỗi skill: `ok` / `missing` / `broken`, kèm thời điểm kiểm.
- Màn hình hiện lệnh `skills add` tương đương (nút Copy). **Plugin không cài skill**; việc đó vẫn thuộc CLI, và chỉ chạy khi người dùng đồng ý (luật cũ giữ nguyên).

### 3.4 `br` và `bv`

- `setup.status` tìm `br`, `bv` (và `bd`, chỉ để thông tin) trên `PATH` của daemon cộng các thư mục cài phổ biến: `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/go/bin`. Với mỗi công cụ tìm thấy, chạy `--version` (timeout 5 giây); nếu thấy `bv` thì **chỉ** chạy `bv --version`.
- Mỗi công cụ hiện: trạng thái, đường dẫn, phiên bản, bản mới nhất đã biết (hằng số trong mã, ghi ngày kiểm), lệnh cài và lệnh cập nhật (nút Copy).
- **Chọn lệnh cài:**
  - có `brew` → `brew install dicklesworthstone/tap/<tool>`;
  - không có `brew`, với `br` → `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash -s -- --skip-skills`. Thêm `--skip-skills` để lời hứa "paseo-bm không ghi vào thư mục skill" vẫn đúng;
  - không có `brew`, với `bv` → `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/a43b8e85a39664381566abdfd85dc8fcbfdcb773/install.sh | bash` (ghim commit như README yêu cầu).
- **Nút Install** chỉ hiện khi thiếu công cụ.
  - Trước khi chạy, hộp xác nhận nêu nguyên văn lệnh và cảnh báo lệnh sẽ tải mã từ mạng.
  - RPC `setup.install-tool({ tool })` chạy đúng lệnh đó trong shell đăng nhập của người dùng (`/bin/zsh -lc` nếu `SHELL` là zsh, còn lại `/bin/bash -lc`), timeout 300 giây, trả mã thoát và 40 dòng cuối của output.
  - Công cụ đã có thì RPC từ chối (`E_TOOL_PRESENT`). Lỗi chạy lệnh trả `E_TOOL_INSTALL_FAILED`. Plugin không bao giờ tự cài.
- **Cập nhật** không chạy từ màn hình: chỉ hiện lệnh để người dùng tự chạy.

### 3.5 CLI

- `W_BEADS_CLI_MISSING` ghi thêm lệnh cài `br`.
- Thêm check `beads-viewer` (cảnh báo, không bao giờ chặn) và mã `W_BEADS_VIEWER_MISSING` cho `install` và `doctor`. Theo AGENTS.md, mã chỉ được thêm, không đổi nghĩa.
- **CLI tự cài `br`/`bv` còn thiếu** (owner chốt ngày 2026-09-16: "khi cài thì tự cài, tên cờ cho bạn chọn"), xem §7.

## 4. Rủi ro

- **Nút Install chạy mã tải từ mạng** bên trong daemon, với quyền của người dùng. Bù lại: chỉ chạy khi người dùng bấm và xác nhận, lệnh hiện nguyên văn, script `bv` ghim commit, script `br` tự kiểm SHA256.
- **`PATH` của daemon** có thể khác `PATH` của terminal, nên màn hình hiện đường dẫn tìm thấy để người dùng đối chiếu.
- **Hướng dẫn bổ sung là chỉ dẫn**, không phải cơ chế cứng; nó không thể gỡ luật an toàn vì luôn đứng sau phần RULES.

## 5. Câu hỏi còn mở

- ~~**Q-S1:** Có cho `npx paseo-bm install` tự chạy trình cài `br`/`bv` không? Tên cờ là gì?~~ **Đã chốt** ngày 2026-09-16, xem §7.

## 6. Kết quả cài đặt và kiểm tra

- **Tên RPC** phải là chữ thường (`/^[a-z][a-z0-9._-]*$/` trong SDK), nên hai RPC có tên `setup.install-tool` và `roles.save-extra`.
- **Hook `agent.create` trả kết quả ngay** cho agent không thuộc paseo-bm; chỉ agent `bm-*` mới tìm install home để đọc phần bổ sung.
- **Thêm ba mã lỗi** vào sổ mã của Dashboard: `E_ROLE_EXTRA_INVALID`, `E_TOOL_PRESENT`, `E_TOOL_INSTALL_FAILED`.
- **Test cô lập `HOME`** ở các file gọi entry của server, để `~/.paseo-bm` thật của máy chạy test không lọt vào kết quả.
- **Kiểm trên daemon thật** (sau lần cài lại `install-reapply-26`):
  - `setup.status`: `br 0.2.10`, `bv v0.16.4`, `bd 1.2.2 (Homebrew)` ở `/opt/homebrew/bin`, lệnh cài qua Homebrew. Đủ 5/5 skill bắt buộc cho cả Claude và Codex; hai skill tuỳ chọn chưa có.
  - `roles.instructions` cho worker: chưa có phần bổ sung, bản đầy đủ trùng bản gốc, đường dẫn `~/.paseo-bm/role-extras.json` (file chưa được tạo).
  - `setup.install-tool` với `br` đã có: bị từ chối với `E_TOOL_PRESENT`, không chạy gì.
- Chưa kiểm được bằng mắt trong app; phần này để owner xem.

## 7. CLI tự cài `br` và `bv` (Q-S1)

Owner chốt: "khi cài thì tự cài, tên cờ cho bạn chọn".

- **Cờ mới `--install-beads-tools`** (chỉ cho `install`), theo mẫu `--install-skills`.
- **Có terminal:** công cụ còn thiếu được cài **trong bước áp dụng**, không hỏi thêm. Ngay dưới preview, trước câu `Apply these changes?`, màn hình in `Missing beads tools (…) will be installed when you apply these changes:` kèm nguyên văn lệnh. Như vậy câu "áp dụng" đã bao gồm việc cài, và M-1 (tối đa ba lần xác nhận) giữ nguyên.
- **Không có terminal:** chỉ cài khi có `--install-beads-tools`; không có cờ thì chỉ in lệnh.
- **Cách cài:** giống màn Setup — có `brew` trên PATH thì chạy `brew install dicklesworthstone/tap/<tool>` (argv, không qua shell); không có thì chạy script chính thức bằng `/bin/bash -c` với chuỗi lệnh cố định (`br` kèm `--skip-skills`, `bv` ghim commit). Timeout 300 giây, output đi như bước skills (dưới `--json` thì vào stderr), Ctrl+C được chuyển tiếp.
- **Sau khi cài:** tìm lại công cụ trên PATH cộng `~/.local/bin`.
  - Tìm thấy: gỡ cảnh báo preflight tương ứng (`W_BEADS_CLI_MISSING` / `W_BEADS_VIEWER_MISSING`). Nếu công cụ chỉ nằm ở `~/.local/bin`, nhắc thêm thư mục này vào PATH.
  - Không tìm thấy hoặc lệnh lỗi: cảnh báo mới `W_BEADS_TOOLS_INSTALL_FAILED` kèm lệnh để tự chạy. **Không bao giờ đổi mã thoát.**
- **`br` chỉ tính là có khi đúng tên `br`**: `bd` không thay được, vì hướng dẫn của Worker dùng `br`.
- **Test không bao giờ tải trình cài thật:** `test/setup/no-real-installers.ts` thay bước mặc định bằng bản không làm gì cho mọi test; test của bước này dùng runner giả.
- **Kiểm bằng CLI thật ở chế độ preview**, với PATH không có `br`/`bv` và không có `brew`: mã thoát 6, hai cảnh báo, và in đúng hai lệnh script cùng lời nhắc dùng `--install-beads-tools`.
