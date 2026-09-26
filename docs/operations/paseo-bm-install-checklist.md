# Checklist nghiệm thu bản cài 0.4.0 trên daemon thật — paseo-bm

| Trường | Giá trị |
|---|---|
| Status | Active — nghiệm thu đường cài duy nhất của 0.4.0: plugin npm, Setup, chuyển đổi, gỡ |
| Áp dụng cho | `paseo-bm-plugin` và `paseo-bm` `0.4.0`; Paseo CLI/daemon **0.9.2** (0.9.2 không còn `cliVersion` trong `daemon status --json`; adapter tự lùi về `paseo --version`) |
| Liên quan | [PRD](../product/paseo-bm-prd.md) · [Design §7.13, §11, §13](../design/paseo-bm.md) · [Design §4.3–§4.6](../design/paseo-bm.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) · [Plan 0.4.0](../plans/paseo-bm-plan-040-single-source.md) |
| Nguồn gốc | Viết lại từ checklist trình cài 0.3.x (`bm-wp-407-prerelease-8t7x.2`); trình cài cũ không còn tồn tại trong 0.4.0 |

Tài liệu này mô tả **cách chạy và cách chấm**; nó không chứa số đo. Mỗi lượt chạy chép mục 10 sang một biên bản riêng ở `docs/archive/operations/paseo-bm-install-run-<YYYYMMDD>.md`. Ngưỡng lấy nguyên văn từ PRD và design; checklist không đặt ngưỡng mới. Chạy khi một bản phát hành đổi đường cài, đổi Setup, đổi lệnh chuyển đổi, hoặc khi lên một phiên bản Paseo mới.

## 1. Phạm vi và nguyên tắc

- Chuỗi chạy: **cài mới từ npm → Setup đủ các bước cần bấm → chuyển một bản cài thư mục 0.3.1 sang npm → cập nhật → gỡ → trả máy về trạng thái ban đầu**, trên **daemon Paseo thật**.
- Đặt paseo-bm và thư mục skills của lượt chạy trong một `HOME` tạm ở những bước làm được, còn `PASEO_HOME` vẫn trỏ `~/.paseo` thật để dùng daemon thật. Nhờ vậy skills do CLI `skills` cài không đổ vào thư mục skills thật của bạn.
- **Lượt chạy sửa `~/.paseo/config.json` thật**: Paseo ghi mục `plugins`, và plugin tạo ba vai trò `bm-*` cùng công tắc `daemon.mcp.injectIntoAgents` khi bạn bấm. Mục 3 backup trước; mục 9 trả về trạng thái ban đầu.
- **Không chạy `paseo daemon restart` hay `stop`** ở bất kỳ bước nào: nó có thể giết agent đang chạy.
- Không bao giờ dùng `--id` khác cho `paseo-bm` (design §4.3): hai bản paseo-bm cùng máy sẽ cùng tạo vai trò và cùng chèn hướng dẫn.
- Gặp tình huống checklist không lường trước: **dừng và ghi lại**, không tự ứng biến.

## 2. Biến dùng trong checklist

```bash
export RUN=~/bm-acceptance/$(date -u +%Y%m%d)/install-040
export EVID=$RUN/evidence
export REAL_PASEO_HOME="$HOME/.paseo"
export CLEAN_HOME=$RUN/home                 # HOME tạm cho dữ liệu paseo-bm và skills
export REPO=/Users/Shared/work/self/paseo-plugins/paseo-bm
export TAG=next                             # 0.4.0-alpha.0 nằm ở dist-tag `next`
mkdir -p "$EVID" "$CLEAN_HOME"
# Mô phỏng máy đã có Claude Code và Codex: không có hai thư mục này thì Setup coi
# hai agent là CHƯA CÀI và cột skills của chúng không đo được.
mkdir -p "$CLEAN_HOME/.claude" "$CLEAN_HOME/.codex"
```

> **Bẫy đã gặp (0.3.x, vẫn đúng):** một lệnh tương tác chạy qua `| tee` thì stdout không còn là terminal, nên CLI coi là **không có TTY** và không hỏi gì. Lệnh cần trả lời câu hỏi phải chạy qua `script -q <log> …`, giữ TTY mà vẫn ghi log.

> Plugin đọc thư mục dữ liệu theo `PASEO_BM_HOME` → con trỏ `~/.paseo-bm/home.json` → `~/.paseo-bm`, và **plugin chạy trong tiến trình daemon**, nên `HOME` của terminal không đổi được nó. Muốn plugin ghi vào `HOME` tạm thì phải đặt `PASEO_BM_HOME` trong môi trường của **daemon** trước khi mở app; nếu không làm được, chấp nhận plugin dùng `~/.paseo-bm` thật và ghi rõ trong biên bản.

## 3. Chuẩn bị và backup

1. Ghi lại phiên bản: `paseo --version`, `paseo daemon status --json | tee "$EVID/daemon-status-before.json"`. Yêu cầu **0.9.0 trở lên**; nhỏ hơn thì dừng (0.4.0 không hỗ trợ).
2. Backup config thật và danh sách plugin:
   ```bash
   cp "$REAL_PASEO_HOME/config.json" "$EVID/config.before.json"
   paseo plugin ls --json | tee "$EVID/plugin-ls-before.json"
   ```
3. Ghi lại trạng thái công tắc trước khi chạy, để mục 9 so lại:
   ```bash
   python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("injectIntoAgents:",d.get("daemon",{}).get("mcp",{}).get("injectIntoAgents"))' "$EVID/config.before.json" | tee "$EVID/switch-before.txt"
   ```
4. Ghi lại có sẵn `bm-*` nào trong config chưa (phải không có, nếu máy chưa từng dùng paseo-bm):
   ```bash
   grep -o '"bm-[a-z0-9-]*"' "$EVID/config.before.json" | sort -u | tee "$EVID/bm-entries-before.txt"
   ```

## 4. Mục (1) — cài mới trên máy chưa từng có paseo-bm

Điều kiện: `plugin-ls-before.json` không có mục `paseo-bm`, `bm-entries-before.txt` rỗng.

```bash
paseo plugin add "npm:paseo-bm-plugin@$TAG" --json | tee "$EVID/01-plugin-add.json"
paseo plugin ls --json | tee "$EVID/01-plugin-ls.json"
```

Chấm đạt khi:

- `plugin add` thoát 0 và `plugin ls` báo `paseo-bm` với `status` là `running` (hoặc `disabled` nếu công tắc plugin của Paseo đang tắt — bật rồi kiểm lại).
- Trong `plugin ls --json`, mục `paseo-bm` có `installation.identity.kind = "npm"` và `packageName = "paseo-bm-plugin"`. **Đây là phần còn lại của Q-047**: ghi nguyên văn `installation` vào biên bản.

Rồi mở app và làm **đúng các bước Setup của design §7.13**, ghi ảnh hoặc log từng bước:

| Bước | Làm gì | Đạt khi |
|---|---|---|
| a. Vai trò | Mở **Beads Manager** ở sidebar | Plugin tự tạo `bm-manager`, `bm-worker`, `bm-reviewer`; Setup hiện dòng "paseo-bm created its roles with defaults (<provider> · <model>). Change them in Agents." |
| b. Tool agent | **Setup → Set up paseo-bm → Allow agent tools…**, đọc cảnh báo rồi bấm **Allow for every agent** | `daemon.mcp.injectIntoAgents` thành `true`; `ui/setup-state.json` có `agentTools.setBy = "plugin"` và `previous` bằng giá trị ở `switch-before.txt` |
| c. Skills | **Install skills…**, đọc lệnh rồi bấm **Run it** | Lệnh chạy xong, cột skills của Claude Code và Codex đủ 5/5; Setup hiện dòng `Last run: … · exit 0` |
| d. `br` / `bv` | **Setup → Beads tools**, cài cái nào thiếu | `br` và `bv` có đường dẫn trên PATH của daemon |
| e. Đăng nhập | **Setup → Agents → Sign-in** | Provider của Worker báo **Signed in**; nếu không, chạy lệnh Setup hiện rồi mở lại |

Sau đó chạy một yêu cầu thật, đây là **điều kiện ra 1 của MVP-Lock**:

- Manager tạo được Worker.
- Worker tạo được Reviewer.
- Màn **Metric** có trace của yêu cầu đó.

Ghi `paseo plugin logs paseo-bm --json | tail -50 > "$EVID/01-plugin-logs.json"` cho biên bản.

**Đo Q-045 ở đây** (bắt buộc đạt): plugin npm nạp được `zod` và `@getpaseo/plugin` dù `plugin/package.json` không khai `dependencies`. Bằng chứng là chính bước a chạy được — Setup và Manager đều dùng cả hai. Nếu `plugin logs` có lỗi module thì **dừng**: cần thêm `dependencies` trước khi phát hành.

**Đo Q-047 (phần còn lại)**: chạy lại `paseo plugin add` trong một shell **không có TTY** (ví dụ `paseo plugin add … --json < /dev/null > out.json 2>err.txt`) trên một `--id` tạm rồi gỡ ngay, và ghi lại: nó có hỏi tin cậy không, có tự bật `pluginsEnabled` không, và in JSON dạng gì.

## 5. Mục (2) — chuyển một bản cài thư mục 0.3.1 sang npm

Làm hai lần: một lần với thư mục cài mặc định, một lần với `--home`.

```bash
# Dựng lại một bản cài 0.3.x: gỡ bản npm trước, rồi cài 0.3.1 như cũ.
paseo plugin remove paseo-bm --json
HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" npx --yes paseo-bm@0.3.1 install --apply --enable-plugins
paseo plugin ls --json | tee "$EVID/02-before.json"
# Chuyển:
HOME="$CLEAN_HOME" PASEO_HOME="$REAL_PASEO_HOME" script -q "$EVID/02-migrate.log" npx --yes "paseo-bm@$TAG"
```

Chấm đạt khi:

- Lệnh in bản xem trước rồi hỏi một câu, mặc định **No**; trả lời Yes thì thoát **0**.
- `paseo plugin ls --json` báo `paseo-bm` với `identity.kind = "npm"`, `packageName = "paseo-bm-plugin"`, `status` `running` (hoặc `disabled`).
- `$CLEAN_HOME/.paseo-bm/install.json` có `schemaVersion: 2` và `migratedTo: { source: "npm", package: "paseo-bm-plugin", version: "0.4.0-…", at: … }`.
- **Giữ nguyên dữ liệu**: `traces/`, `role-extras.json`, `role-fallback*.json`, `ui/` còn đủ; `plugin/0.3.1/` và `backups/` vẫn còn (0.4.0 không xoá).
- Vai trò `bm-*` trong config **không đổi**, công tắc `injectIntoAgents` **không đổi**.
- Mở lại Beads Manager: Metric vẫn thấy trace cũ. Đây là **điều kiện ra 2 của MVP-Lock**.

Lần thứ hai, với thư mục cài khác mặc định:

```bash
HOME="$CLEAN_HOME" npx --yes paseo-bm@0.3.1 install --apply --enable-plugins --home "$RUN/custom-bm"
HOME="$CLEAN_HOME" script -q "$EVID/02b-migrate.log" npx --yes "paseo-bm@$TAG" --home "$RUN/custom-bm"
```

Thêm điều kiện: `$CLEAN_HOME/.paseo-bm/home.json` được tạo, nội dung `{ "schemaVersion": 1, "home": "<RUN>/custom-bm", "writtenBy": "paseo-bm@0.4.0-…", "at": … }`, quyền `0600`, và `$RUN/custom-bm/install.json` mới là cái có `schemaVersion: 2`.

Chạy lại lệnh chuyển lần nữa (**tình huống B**): thoát **0**, không gọi Paseo lần nào, `install.json` không đổi.

## 6. Mục (3) — bản 0.3.1 cũ không cài lại được lên bản npm

Ngay sau mục 5, còn nguyên `install.json` `schemaVersion: 2`:

```bash
HOME="$CLEAN_HOME" npx --yes paseo-bm@0.3.1 install --apply 2>&1 | tee "$EVID/03-old-install.log"; echo "exit=$?"
```

Chấm đạt khi: thoát **3** với `E_RECORD_SCHEMA_TOO_NEW`, và **không đổi gì** — `plugin ls` vẫn là bản npm, config không đổi. Đây là cơ chế duy nhất ngăn một máy đã chuyển bị cài lại thành bản thư mục.

## 7. Mục (4) — cập nhật

```bash
paseo plugin update paseo-bm --json | tee "$EVID/04-update.json"
paseo plugin ls --json | tee "$EVID/04-plugin-ls.json"
```

Chấm đạt khi: thoát 0, `status` trở lại `running`, và dữ liệu trong thư mục dữ liệu **không đổi** (so `ls -la` trước/sau).

**Đo Q-046**: so `path` của mục `paseo-bm` trong `04-plugin-ls.json` với `02-before.json`. Ghi lại `plugin update` có đổi đường dẫn đăng ký hay không — nếu có, thư mục gói do Paseo quản lý đổi mỗi lần cập nhật, đúng như design §5.1 giả định.

## 8. Mục (5) và (6) — gỡ cấu hình, và xung đột id

**(5) Gỡ.** Làm hai lần, mỗi lần dựng lại bản cài ở mục 4 trước:

1. Lần một, **giữ dữ liệu**: Setup → **Remove paseo-bm's settings…** → **Remove settings** → **Keep my data**.
2. Lần hai, **xoá dữ liệu**: cùng đường, nhưng chọn **Delete data**.

Rồi mỗi lần:

```bash
paseo plugin remove paseo-bm --json | tee "$EVID/05-remove.json"
cp "$REAL_PASEO_HOME/config.json" "$EVID/05-config-after.json"
grep -o '"bm-[a-z0-9-]*"' "$EVID/05-config-after.json" | sort -u | tee "$EVID/05-bm-entries-after.txt"
```

Chấm đạt khi (**điều kiện ra 3 của MVP-Lock**):

- `05-bm-entries-after.txt` rỗng: không còn provider hay profile `bm-*` nào, kể cả alias dự phòng.
- `injectIntoAgents` trở lại đúng giá trị trong `switch-before.txt` — chỉ khi chính paseo-bm bật nó; nếu bạn đã bật sẵn thì màn hình phải báo **left on** và giá trị **không đổi**.
- Lần một: thư mục dữ liệu còn nguyên. Lần hai: `traces/`, `role-extras.json`, `role-fallback*.json` và mọi thứ trong `ui/` **trừ** `ui/setup-state.json` đã mất; `install.json`, `plugin/`, `backups/`, `home.json` còn.
- Cả hai lần: skills, `br`, `bv` **không bị chạm**.
- Cài lại plugin mà **chưa** bấm "Set up again": Setup báo settings đã bị gỡ và **không tự tạo lại vai trò** (REQ-012 e). Bấm **Set up again** thì tạo lại.

**(6) Xung đột id.** Dựng một bản cài thư mục 0.3.1 (như mục 5), rồi:

```bash
paseo plugin add "npm:paseo-bm-plugin@$TAG" --json 2>&1 | tee "$EVID/06-conflict.log"
```

Chấm đạt khi: bị từ chối với **đúng nguyên văn**

```
Plugin ID "paseo-bm" is already configured; choose another ID with --id
```

và làm theo mục "coming from `npx paseo-bm`" của README — tức chạy `npx paseo-bm@$TAG` một lần — thì giải quyết được. **Không** thử `--id` khác ở bất kỳ bước nào.

## 9. Trả máy về trạng thái ban đầu

1. Setup → **Remove paseo-bm's settings…** (nếu còn), rồi `paseo plugin remove paseo-bm`.
2. So `~/.paseo/config.json` với `$EVID/config.before.json`; khác chỗ nào thì sửa tay về đúng bản backup, trừ khoá `plugins` rỗng mà Paseo để lại (khoá đó là của Paseo).
3. Xoá `$RUN` nếu không cần giữ, và xoá `~/.paseo-bm` **chỉ khi** nó do lượt chạy này tạo.
4. Không chạy `paseo daemon restart`/`stop`.

## 10. Phiếu ghi biên bản

Chép mục này sang `docs/archive/operations/paseo-bm-install-run-<YYYYMMDD>.md`.

### Lượt chạy 0.4.0 — <ngày>

| Trường | Giá trị |
|---|---|
| Ngày, người chạy | |
| `paseo --version` / `daemonVersion` | |
| Phiên bản thử | `paseo-bm-plugin@…`, `paseo-bm@…` |
| Máy | |

| Mục | Kết quả | Bằng chứng | Ghi chú |
|---|---|---|---|
| (1) Cài mới từ npm + đủ bước Setup | đạt / không | | |
| (1) Manager → Worker → Reviewer, Metric có trace | đạt / không | | Điều kiện ra 1 |
| (2) Chuyển bản thư mục, thư mục mặc định | đạt / không | | Điều kiện ra 2 |
| (2) Chuyển bản thư mục, `--home` + con trỏ `home.json` | đạt / không | | |
| (2) Chạy lại lệnh chuyển (tình huống B) | đạt / không | | |
| (3) `paseo-bm@0.3.1 install` bị chặn, thoát 3 | đạt / không | | |
| (4) `paseo plugin update paseo-bm` | đạt / không | | |
| (5) Gỡ, giữ dữ liệu | đạt / không | | Điều kiện ra 3 |
| (5) Gỡ, xoá dữ liệu | đạt / không | | |
| (5) Chưa "Set up again" thì không tạo lại vai trò | đạt / không | | REQ-012 e |
| (6) Xung đột id, đúng nguyên văn thông báo | đạt / không | | |

| Câu hỏi | Đo được gì | Kết luận |
|---|---|---|
| Q-045 — plugin npm nạp được `zod` và `@getpaseo/plugin`? | | **bắt buộc đạt** |
| Q-046 — `plugin update` có đổi `path` đăng ký? | | |
| Q-047 (còn lại) — `plugin add npm:… --json` không TTY: hỏi tin cậy? tự bật `pluginsEnabled`? JSON dạng gì? | | |

Q-044 **đã đóng** (design §13, đo 2026-09-25): `paseoTools.enabled` của provider một mình **không** cấp tool Paseo cho agent, nên nút tool agent ở mục 4b là bắt buộc — không đo lại. Phần `plugin ls --json` của Q-047 đã trả lời trên `paseo-cafe`; mục 4 xác nhận lại cho `paseo-bm-plugin`.

REQ-070 (e): ghi lại lượt chuyển đổi có giữ nguyên dữ liệu, vai trò và công tắc hay không, kèm bằng chứng.

## 11. Hạn chế đã biết

- Checklist chạy trên **một máy, một daemon**; không đo nhiều daemon hay máy nhiều người dùng.
- `PASEO_BM_HOME` chỉ đổi được thư mục dữ liệu của plugin nếu đặt được trong môi trường của daemon; nếu không, lượt chạy dùng `~/.paseo-bm` thật và biên bản phải nói rõ.
- Chuỗi "gỡ rồi cài lại" đi qua `paseo plugin remove`/`add` thật, nên con trỏ `plugins` trong config thật thay đổi nhiều lần trong một lượt; mục 9 là bước duy nhất đưa nó về.
