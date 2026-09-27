# Test thủ công paseo-bm trên một daemon Paseo cô lập

Bộ script này dựng một daemon Paseo **riêng** (home riêng, cổng riêng, thư mục dữ liệu paseo-bm riêng), cài plugin từ thư mục `plugin/` của nhánh đang checkout, rồi cho bạn gọi RPC và gửi tin như app. Daemon thật của bạn (`~/.paseo`, cổng 6767) và `~/.paseo-bm` không bị đụng tới; mọi script Node từ chối chạy nếu không có `BM_TEST_WS` hoặc nếu nó trỏ vào cổng 6767.

Đây là cách đã dùng để nghiệm thu 0.4.0 (biên bản `docs/archive/operations/paseo-bm-install-run-20260926.md`). Khác một điểm: ở đây plugin được cài **từ thư mục** (`paseo plugin add <repo>/plugin`) để thử mã chưa publish; đường cài từ npm đã được nghiệm thu với gói thật.

| Script | Việc |
|---|---|
| `start-daemon.sh <work-dir> [port]` | dựng và chạy daemon cô lập (cổng mặc định 6899), ghi `<work-dir>/env.sh` |
| `stop-daemon.sh <work-dir>` | dừng đúng daemon đó (kiểm home và cổng trước khi dừng) |
| `new-workspace.sh <tên>` | tạo repo git nhỏ trong `<work-dir>`, đăng ký project + workspace, in `workspaceId` |
| `rpc.mjs <method> ['<json>']` | gọi RPC của plugin như app (`manager.ensure`, `setup.status`, …) |
| `send.mjs <agentId> "<text>"` | gửi tin như người dùng gõ trong app |
| `agents.mjs` | liệt kê agent: provider, model đang chạy, trạng thái, mode, nhãn |
| `create-agent.mjs …` | tạo agent trực tiếp, để xem hook `before("agent.create")` làm gì |
| `wait-idle.mjs [phút]` | chờ tới khi không agent nào chạy |

## 0. Chuẩn bị

```bash
git fetch origin
git switch test/manual-0.4.1
npm install            # nếu chưa có node_modules
npm run build          # sinh lại plugin/server/*-instructions.ts và version
npm run verify         # 107 file test, phải xanh
```

Cần: Paseo 0.9+ (CLI `paseo` trên PATH), Claude Code đã đăng nhập; Codex đã đăng nhập nếu chạy mục 3.

## 1. Dựng daemon và cài plugin của nhánh

```bash
WORK=$HOME/bm-manual-test        # thư mục làm việc, xoá được sau khi xong
scripts/manual-test/start-daemon.sh "$WORK"
source "$WORK/env.sh"            # mọi shell dùng để test đều phải source file này

paseo plugin add "$PWD/plugin" --json    # mong đợi: "status": "running"
paseo plugin logs paseo-bm               # mong đợi: Loading plugin → Plugin ready
WS_ID=$(scripts/manual-test/new-workspace.sh demo); echo "$WS_ID"
```

## 2. Kịch bản kiểm

### 2.1 Cài trắng: Manager không được tạo khi tool agent còn tắt

```bash
node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}"
```
Mong đợi — lần đầu (vừa tạo vai trò): lỗi `E_PROVIDER_UNAVAILABLE: paseo-bm created its roles with defaults (claude · …). Change them in Setup → Agents. Paseo's agent tools are off, and a Beads Manager created now would never get them, …`

```bash
node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}"
node scripts/manual-test/agents.mjs
```
Mong đợi — lần hai: chỉ còn câu về tool agent (không còn câu về vai trò); `agents.mjs` in `[]` (không agent nào được tạo).

```bash
node scripts/manual-test/rpc.mjs setup.grant-agent-tools '{}'                    # thiếu xác nhận → bị từ chối
node scripts/manual-test/rpc.mjs setup.grant-agent-tools '{"confirmed":true}'    # → injectIntoAgents: true
MGR=$(node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agentId))'); echo "$MGR"
```
Mong đợi: Manager được tạo (`created: true`).

`node scripts/manual-test/rpc.mjs setup.status` cho xem toàn bộ tình trạng máy mà màn Setup hiển thị (vai trò, tool agent, đăng nhập, skills, thư mục dữ liệu).

### 2.2 Một việc đầu cuối (tốn token của provider)

```bash
node scripts/manual-test/send.mjs "$MGR" "Thêm hàm subtract, multiply và divide vào math.js (divide ném lỗi khi chia cho 0), kèm unit test bằng node:test trong test/math.test.js. Coi đây là việc cỡ Medium và cho Reviewer xem lại."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/agents.mjs
paseo logs "$MGR"
(cd "$BM_TEST_WORK/demo" && git status --short && npm test)
```
Mong đợi: có Manager, một Worker và một Reviewer; Worker tạo và đóng bead; test trong repo `demo` đạt; Manager báo `finished` bằng tiếng Việt, liệt kê các lựa chọn Worker tự quyết. Nếu một agent chờ cấp quyền, `wait-idle.mjs` dừng lại và báo.

### 2.3 Đổi Worker sang Codex: model cũ bị sửa về model của profile

```bash
REV=$(node scripts/manual-test/rpc.mjs roles.settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')
node scripts/manual-test/rpc.mjs roles.options '{"provider":"codex"}'     # xem model Codex có sẵn
node scripts/manual-test/rpc.mjs roles.save-settings "{\"revision\":\"$REV\",\"role\":\"worker\",\"baseProvider\":\"codex\",\"model\":\"gpt-5.6-sol\",\"thinkingOptionId\":null,\"modeId\":null}"

# Giả làm một Manager cũ còn nhớ model Claude, kèm mức thinking của Claude:
AGENT=$(node scripts/manual-test/create-agent.mjs bm-worker claude-opus-5-5 max full-access "$BM_TEST_WORK/demo" "$WS_ID" "Reply with the single word OK. Do not run any tool.")
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/agents.mjs        # agent "manual create-agent check": model gpt-5.6-sol
paseo inspect "$AGENT"                    # Thinking là mức của Codex, không phải "max"
paseo logs "$AGENT"                       # trả lời "OK", không lỗi model
paseo plugin logs paseo-bm                # [paseo-bm] bm-worker was asked for model "claude-opus-5-5", but its profile names "gpt-5.6-sol"; …
```
(Thay `gpt-5.6-sol` bằng một model mà `roles.options` liệt kê trên máy bạn.)

Muốn xem cả luồng thật: gửi cho `$MGR` (Manager tạo trước khi đổi) một việc mới **không** nêu model, rồi `agents.mjs` — Worker mới chạy trên Codex.

### 2.4 Gỡ cấu hình và gỡ plugin

```bash
node scripts/manual-test/rpc.mjs setup.cleanup '{"confirmed":true,"deleteData":false}'
cat "$PASEO_HOME/config.json"             # không còn mục bm-*, injectIntoAgents trả về false
paseo plugin reload paseo-bm --json
node scripts/manual-test/rpc.mjs setup.ensure-roles    # skipped: "cleaned-up" — không tự tạo lại
paseo plugin remove paseo-bm
```

## 3. Phần không chạy tay được — kiểm bằng test

| Hành vi | Test |
|---|---|
| Switch dự phòng (Manager, Worker) từ chối khi tool agent tắt, sự cố giữ `pending`; chính sách Auto | `npx vitest run test/fallback-manager.test.ts test/fallback-switch.test.ts test/fallback-auto.test.ts` — cần một lần hết hạn mức thật mới kích được trên daemon |
| Câu trạng thái tool agent trên Setup; dòng lỗi launcher không còn `Request failed: … requestType=…` và không lặp mã | `npx vitest run test/plugin-setup-model.test.ts test/plugin-launcher.test.ts test/agent-tree.test.ts` — là giao diện trong app; daemon cô lập không có app nối vào |
| Hook: model, thinking, feature của OpenCode | `npx vitest run test/plugin-role-hook.test.ts` |

## 4. Dọn

```bash
scripts/manual-test/stop-daemon.sh "$WORK"
rm -rf "$WORK"
```
Không bao giờ dùng `paseo daemon stop` ở đây: thiếu `--home` đúng là nó dừng daemon thật của bạn.
