# 高千穗峽划船預約工具

在 macOS Apple Silicon 上執行的 TypeScript／Playwright CLI，使用真正的 Chrome 或 Chromium 操作 [EIPrO 官方網站](https://eipro.jp/takachiho1/)。乘船日期、開賣時間、1–2 個獨立時段及各船個資都由 `config/config.local.json` 指定。範例目標為 **2026-10-24、10:00 與 10:30**（乘船時段為日本時間）。

範例開放時間為 **2026-10-10 09:00:00 Asia/Tokyo = 2026-10-10 08:00:00 Asia/Taipei = 2026-10-10 00:00:00 UTC**，符合[官方乘船日前兩週日本時間 09:00 開放的規則](https://www.takachiho-kanko.info/boat/menu_pageLnk/)；監控截止為 **2026-10-10 10:00:00 Asia/Taipei**。變更 local config 即可切換目標。正式模式為每個設定時段準備獨立瀏覽器程序與 BrowserContext，開放後各自查詢、選取、填寫客戶資料。使用兩時段時，一個失敗、變慢或成功，不會中止另一個。

## 目前本機設定：10/12 搶 10/26

已有本機個資設定與安裝完成的套件時，在 Mac 終端執行：

```bash
cd /Users/zhi-honglee/projects/takachiho
npm run doctor
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

確認 doctor 顯示目標 `2026-10-26`、時段 `11:00 / 11:30`，開始查詢為 **2026-10-12 台灣 07:58**、開賣時間為 **08:00**、正常回應後等待 **750 ms**，並顯示「搶位設定檢查通過」。乘船時段為日本時間。缺少近期填表紀錄、顯示「待當次表單確認」仍可啟動。程式須提前啟動；預設在開始查詢前 120 秒預熱，07:58 起持續查詢，看到官方明確允許預約才搶位。已過開始查詢時間時會直接監控，持續至台灣 10:00；截止後須先在 local config 設定新的未來預約日期與監控時間才能再次啟動。已有 local config 不要重新複製 example，以免覆寫個資。

取得船位並完成自動填表後，在同一終端輸入 `handoff 11:00` 或 `handoff 11:30`，再到對應瀏覽器完成最後確認與付款。保持終端及兩個瀏覽器開啟；`q` 會關閉瀏覽器並離開。

2026-10-08 已在 Cloud 透過官方正常 UI 暫留一次、進入一份真實客戶表單，確認 9 個客戶欄位及人數選項；沒有填入個資、勾同意、送出或付款。範例已包含這些實際 mappings。**這次不是執行本 repo 的 hold adapter，也不是 Mac Autofill 驗證**；仍需在 Mac 的受保護 full rehearsal 中確認目前表單並實測填寫。真站範圍見 [REAL_SITE.md](docs/REAL_SITE.md)、[10/8 表單勘查](docs/FORM_20261008.md)，離線驗證見 [VALIDATION.md](docs/VALIDATION.md)。

## Mac 安裝

需求：macOS Apple Silicon、原生 arm64 Node.js **22 以上**、Git。範例設定使用安裝程序下載的 Chromium；也可以選擇已安裝的 Google Chrome。無需 Vercel、資料庫、VPS 或瀏覽器外掛。

GitHub repository：[Zhong-627/takachiho-sniper](https://github.com/Zhong-627/takachiho-sniper)。

```bash
git clone https://github.com/Zhong-627/takachiho-sniper.git takachiho-reservation
cd takachiho-reservation
npm run setup
cp config/config.example.json config/config.local.json
npm run check
```

`npm run setup` 一次完成鎖定版本相依套件安裝、Playwright Chromium 下載及 TypeScript 編譯。預設 `browser.channel: "chromium"` 可直接執行；使用已安裝的 Chrome 時可改成 `"chrome"`。先確認 `node -p process.arch` 顯示 `arm64`。本工具不代替 macOS 系統時間同步。

## 更改預約日期與時間

在 Mac 執行 `open -e config/config.local.json`。以下是需合併到原檔的設定片段，保留既有 browser、customers、mappings 等設定；日期與開賣時間僅作格式示意，請依官方當次規則核對：

```json
{
  "targetDate": "2026-10-27",
  "releaseAt": "2026-10-13T08:00:00+08:00",
  "monitorFrom": "2026-10-13T07:58:00+08:00",
  "monitorUntil": "2026-10-13T10:00:00+08:00",
  "slots": ["11:00", "11:30"],
  "polling": { "baseDelayMs": 750, "maxDelayMs": 20000 }
}
```

| 設定 | 意義與要求 |
| --- | --- |
| `targetDate` | 日本當地的乘船日期，必填 `YYYY-MM-DD` |
| `releaseAt` | 開賣的絕對時間，必填含時區的 ISO 字串；台北用 `+08:00`、日本用 `+09:00`，也可用 UTC `Z` |
| `monitorFrom` | 開始持續查詢的時間，選填含時區的 ISO 字串，須早於或等於 `releaseAt`；未填則從開賣時間開始 |
| `monitorUntil` | 正式模式必填的監控截止時間，須含時區且晚於 `releaseAt`；例如 `2026-10-09T10:00:00+08:00` 是台灣 10/9 10:00 |
| `polling.baseDelayMs` | 每次正常回應後的基礎等待時間，最低 750 ms；仍有小幅隨機偏移，完整查詢週期還須加上網站回應時間 |
| `slots` | 1–2 個不同的日本當地乘船時間，必填兩位數 `HH:mm`，須為官方實際提供的時段 |
| `customers[時段]` | 各船對應的代表人、9 個 fields 與 mappings；key 必須與該 slot 完全相同 |

例如把原 `customers["10:00"]`、`customers["10:30"]` 的 key 改為 `"11:00"`、`"11:30"`，保留各船自己的個資與已確認的 mappings。只預約一艘時，slots 可為 `["11:00"]`；未列入 slots 的客戶設定不會啟動預約。程式不自動推算開賣日，也不因時間格式合法就認定網站有該時段，仍須核對官方 availability。漏填日期、開賣時間或 slots 會報錯，不會使用舊目標。

儲存後執行 `npm run doctor`，核對輸出的 targetDate、slots 及台北／日本開賣時間。doctor 分別報告搶位設定與各時段的填表狀態；缺少近期相符的 Autofill receipt 只會提示「待當次表單確認」，不阻止啟動。正式 `live` 的目標全部取自設定檔，不接受 `--date`／`--slot` 覆寫。執行中 `f` 只可重新載入個資及 mappings；若日期、開賣時間或 slots 已變更，會停止填寫並保留原頁，先確認既有 hold 狀態再另行啟動。

## 模式與命令

| 模式 | 用途 | 可建立 hold | 必要確認 |
| --- | --- | --- | --- |
| `inspect` | 真站日曆、日期、設定時段、DOM、網路、session、畫面診斷 | 否 | 無 |
| `rehearsal` | 真站設定時段獨立讀取，顯示將採用的 reservation action | 否 | 無 |
| `full-rehearsal` | 真站選取單一可預約時段、客戶頁檢查、Autofill 驗證 | 是，一次 | `--slot`、`--confirm-reservation-side-effects` |
| `live` | 從設定開始時間持續監控 1–2 個時段至截止時間 | 是；只有明確失敗且確認額滿才能重試 | `--confirm-reservation-side-effects`、本機設定檢查；自動填表須核對當次 DOM |

```bash
npm run doctor
npm run inspect
npm run rehearsal -- --attempts 3
npm run full-rehearsal -- --slot 10:00 --date YYYY-MM-DD --confirm-reservation-side-effects
npm run live -- --confirm-reservation-side-effects
npm run doctor -- --manual-customer-form
npm run live -- --manual-customer-form --confirm-reservation-side-effects
```

`YYYY-MM-DD` 請換成從 inspect 確認、目前已開放且有餘位的日期，`--slot` 改成 slots 中其中一個時間。full rehearsal **真的會占用一個時段**，只能在有此意圖時執行。範例目標 2026-10-24 在 10 月 10 日開放前沒有可執行的 hold，不能用這個未開放日期驗證客戶表單。

所有命令預設讀取 `config/config.local.json`，也接受 `--config <本機 JSON 路徑>`。`inspect`、`rehearsal`、`full-rehearsal` 可用 `--date`；`live` 完整使用 local config 的日期、開賣時間及時段。安全模式可加 `--headless` 或 `--close`，供非互動診斷使用；有 side effect 的模式必須保留可見瀏覽器。

`live` 預設在取得船位後檢查當次表單並嘗試自動填寫；不要求先占用其他日期取得 receipt。可在 `live`／`doctor` 加 `--manual-customer-form`，讓所有客戶資料由人工填寫。人工模式仍需各船的真實 `representativeName`、不同代表人及正確預約目標；`fields`／`mappings` 可留空，`f` 停用，取得位置後輸入 `handoff` 在瀏覽器填寫。

預設保持瀏覽器開啟，CLI 終端可輸入：

| 命令 | 行為 |
| --- | --- |
| `f [HH:mm]` | 自動填表模式在目前已 hold 的客戶頁重新載入本機設定並填寫／驗證；不再選取時段。人工填表模式停用此命令。省略時段會處理所有已結束的 flow |
| `handoff [HH:mm]` | 僅在已授權 reservation 模式把已 hold 的流程交由使用者操作，停止自動化並移除 HTTP 防護。省略時段會處理所有可交接的 flow |
| `q` | 關閉瀏覽器並離開；關閉不代表立即取消伺服器 hold |

安全模式不提供 `handoff`，其網路防護持續有效。人工接手後，由使用者自己操作最後確認、信用卡、OTP、CAPTCHA 與 3D Secure；程式不提交預約或付款，不輸入安全驗證資訊。

## 第一輪真站演練

先執行 `npm run inspect`，查看日曆、設定日期與各時段是否被識別，並確認診斷沒有未處理的封鎖、CAPTCHA、維護或頁面異動。再執行 `npm run rehearsal -- --attempts 3`。若目標日尚未開放，看到 `unavailable` 或預約未開始是合理結果；**剩餘船數不等於可預約**。

若要驗證「目前可預約時段會如何選取」，先以 `inspect -- --date YYYY-MM-DD` 檢查已開放日期，再用相同日期執行 `rehearsal`。安全演練只列出正式流程會發出的 action，永遠不點選建立 hold。

若有目前可預約時段且確實希望演練，可依 [Mac 檢查清單](docs/MAC_CHECKLIST.md) 執行單一時段 full rehearsal，取得真實客戶欄位。這是選用演練，不是 live 啟動的前置條件；沒有餘位可演練時，仍可等待正式開賣，取得目標船位後檢查表單。

## 本機個資與 Autofill

所有個資只放在 `config/config.local.json` 的 `customers`，每個設定 slot 各自一組資料。`representativeName` 是該船的實際代表人；官方頁面表示同一代表人不可同時預約多艘船，所以兩組必須是不同代表人。程式會在 side effect 前檢查，不會把代表人記入 log。

clone 到 Mac 後，於專案目錄建立並開啟本機設定：

```bash
cp config/config.example.json config/config.local.json
open -e config/config.local.json
```

已有 local config 時不要再次複製覆寫。使用 VS Code 也可執行 `code config/config.local.json`。個資填在 local 檔的 `customers[時段]`；範例為 `customers["10:00"]`、`customers["10:30"]`，改時段時同步改 key。不要把個資填進會提交的 example。每船各填 `representativeName` 與下列 `fields`，已提供的 mappings 先保留，Mac 當次 DOM 不一致時停止並重新核對。

| fields key | 本機填入的資料 |
| --- | --- |
| `familyName`／`givenName` | 姓／名；合併後須與該組 `representativeName` 相符（忽略空白、全半形，接受姓前或名前） |
| `familyNameKana`／`givenNameKana` | 姓／名的片假名 |
| `email` | 可收確認信的 Email，官方建議 Gmail |
| `mobilePhone` | 可即時聯繫的電話；台灣號碼格式待真站確認 |
| `address` | 住家地址；海外填法待確認 |
| `birthDate` | 代表人生日；精確輸入格式與網站格式化行為待 Mac 確認，不由程式猜測 |
| `passengerComposition` | [勘查表](docs/FORM_20261008.md) 內完整日文 option value，例如 `大人２名、未就学児２名`；依該船實際組合選擇 |

`representativeName` 放在每船設定頂層；真實表單拆成姓／名，因此不要再將它放入 fields 並指向不存在的完整姓名欄位。若沿用舊 local config，請把舊完整姓名 mapping 換成範例的姓／名 mappings，合併其餘 9 個欄位並填值。`config/*.local.json`、`.local/`、`artifacts/` 都已被 `.gitignore` 排除。

`fields` 保存本機欄位 key 與值；`mappings` 將 key 對應到**真實客戶頁已檢查的唯一 selector**，可選 `kind: "fill" | "select" | "check"`。範例中的 9 個 selector 是 10/8 實際觀察，8 個 input 用 fill，人數用 select；沒有猜測或自動同意的 check mapping。過去一份表單不保證正式日期／時段完全相同，執行時仍重新核對唯一、可見、可編輯控制項。

首次 full rehearsal 可先只設定代表人，將 fields 與 mappings 明確改為空的 `{}`／`[]`，以便只檢查表單；或先在 local config 填妥 9 個欄位，使用已觀察的 mappings。工具輸出可見欄位、labelSource、id、name、HTML 限制、選項及唯一 selector，不擷取欄位值。`htmlRequired` 是原始 DOM 值，`required`／`requiredSources` 另含可見必填標記與已確認的本機要求，避免官方 required=false 造成漏填。片假名依「全部資訊」說明採保守非空檢查，不宣稱伺服器一定必填。

檢查 `form-HHmm.json`（例如 `form-1000.json`）後，自動填表模式可在同一客戶頁修改 local config 的個資／mappings，於 CLI 輸入 `f`；不重新 hold。工具在第一欄填寫前核對全部 mappings、必填客戶欄位及人數選項；缺少 mapping 或出現用途不明的必填欄位時整批停止。填寫中若欄位改變、值不一致或 HTML validity 失敗，也停止後續填寫並提示 `handoff`。付款、規約、未知用途仍不自動操作。這些檢查不是送出後的伺服器驗證，也未證明生日或海外資料格式會被接受。

full rehearsal 或 live 的客戶欄位填寫與 HTML 檢查通過後會建立 `.local/form-verification.json`，作為歷史參考。receipt v2 簽章包含驗證規則版本、mapping 定義與欄位 key；沒有姓名或其他個資，也不雜湊個資值。v1 舊紀錄不列為近期參考，不應手寫新紀錄。7 天內且 mapping／欄位 keys 相符時顯示「已有近期紀錄」；缺少、過期或定義改變時顯示「待當次表單確認」，兩者均可啟動 live。每次自動填表都重新核對目前 DOM 與填寫結果。失敗或人工模式不建立驗證紀錄；參考紀錄寫入失敗也不會丟棄已取得的船位。

遇到未支援欄位、缺少 mapping、瀏覽器驗證失敗或安全驗證欄位，工具保留頁面並提示人工接手，不會宣稱 Autofill 成功。付款、信用卡、OTP、密碼、CAPTCHA、同意規約及最後確認屬人工欄位。

`.gitignore` 已排除 `config/*.local.json`、`.env*`、`.local/`、`artifacts/`、logs、瀏覽器產物。仍須把個資放在排除路徑，不要改寫已追蹤的 example。若要分享診斷，先人工檢查畫面與文字是否含個資。

## 正式執行

設定開賣時間前確認 Mac 時間自動同步、接上電源、網路穩定，且 doctor 的搶位設定檢查通過，inspect／安全演練可正常讀取目標。歷史填表紀錄僅供參考。保持終端與 Chrome 開啟，建議提前數分鐘執行：

```bash
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

程式按 `warmupSeconds` 在開始查詢前提前準備頁面，預設 120 秒；到 `monitorFrom`（未填則 `releaseAt`）後，各 context 使用官方日曆 `refetchEvents` 重新查詢自己的時段。本機及 example 設定為 750 ms；省略 `polling.baseDelayMs` 時沿用原預設 1250 ms。正常查詢在回應完成後等待此基礎時間，保留小幅 jitter（750 ms 設定的正常等待約 750–863 ms）；完整週期另加網站回應時間。兩時段互不阻塞。

開放前，只有有效且未報錯的日曆回應能將「時段尚未出現」識別為正常等待，維持基礎間隔，仍不允許搶位。若正常等待會跨過 `releaseAt`，會縮短該次等待，在開放時間重新查詢；若上一筆正常查詢於開放後才完成，會立即再查一次，請求不重疊。開放後仍未出現時段、未知資料、錯誤與 429 維持退避，`Retry-After` 不會因開放時間而縮短。

live 不受 `polling.maxAttempts` 或固定 20 分鐘限制，持續至暫留成功、人工停止或 `monitorUntil`。截止後不發起新的查詢或 hold；截止前已送出的 hold 仍確認結果並保留頁面。截止前可以啟動 live，沒有開賣後 20 分鐘的啟動限制。設定於啟動時讀取；修改開始時間、間隔或截止時間後，下次啟動生效，`f` 只重新讀取個資／mappings。

每次 hold 都只有一次請求能力。僅當精確請求收到 HTTP 2xx 且字串 `data.result === "0"`，原頁仍為日曆，重新查詢又確認同一服務／場次的 `is_full === true`，才清除這次失敗狀態並回到監控。成功、逾時、未知回應、資料不符及人工驗證均停止該時段；另一時段繼續。full rehearsal 仍只允許一次 hold。

官方公開說明的 hold 為 **15 分鐘**，以伺服器規則為準。取得後立即檢查客戶頁與 Autofill，保留兩個流程；不要在兩頁使用瀏覽器返回／重新載入來重新選船。最後輸入 `handoff`，自行完成需要的後續流程。若只有其中一個成功，成功頁仍會保留。

效能指標是 **Time To First Valid Reservation Action**：從開放 instant 到第一個有已確認 availability、通過安全檢查的 hold action。工具使用本機 wall clock 與 monotonic timing；毫秒級記錄不代表可保證伺服器或網路毫秒級回應。它不校正伺服器時鐘，也不繞過 queue／WAF。

## Retry 與安全防護

預設每個 slot 在讀取完成後約 1250 ms 再查詢，最低允許 750 ms，加入 jitter。一般售罄持續正常節奏；unknown、網路錯誤及 HTTP 429 使用指數 backoff，預設本機上限 20 秒。若伺服器提供 `Retry-After`，它優先作為最小等待時間，即使長於本機上限。每個 slot 有自己的 retry state、時間預算與 attempt 上限。

安全不是單一 `if (dryRun)`：每個 context 在第一個 navigation 前裝上預設拒絕的網路 guard、封鎖 service worker／WebSocket，只准已確認的公開讀取 URL、query 與 POST body 結構。未知 URL、GET side effect、redirect、付款及未確認 POST 都被擋下。安全模式即使其他程式錯誤呼叫選取，也沒有 hold capability。

只有已確認的 `full-rehearsal`／`live` 可以裝載一個精確 hold request 與一次客戶頁 navigation。hold capability 使用一次即失效，不能因逾時重新裝載。未預期 redirect 也會先被檢查再派送。遇到 CAPTCHA、queue、維護或需要人工驗證時停止自動操作、保留瀏覽器；沒有 bypass 功能。

嚴格 allowlist 可能在官方更新資源或客戶頁載入新 script 後阻擋必要資源。這會留下 `blocked` 診斷，需要重新安全檢查官方來源；不要以允許所有 URL 來修復。客戶頁額外資源尚須在 Mac full rehearsal 確認。

## Logs、畫面與診斷

每次執行在 `artifacts/` 建立獨立目錄。JSONL log 記錄 UTC、JST、台北時間、monotonic elapsed ms、navigation／request latency、HTTP status、redirect、availability、retry、reservation action、customer form、Autofill 與錯誤。slot 事件明確標示設定的 `HH:mm`，可比較各流程與開放瞬間的時間差。

診斷包含 DOM metadata、當前時段資訊、navigation timing、Cookie／session metadata 及 screenshots；不輸出 Cookie 值、action token、POST body 或個資。客戶頁 screenshots 會遮蔽輸入欄位；人工填寫與官方頁面仍可能顯示其他敏感資訊，分享前須人工檢查。工具不保存 storageState、HAR、Playwright trace 或完整客戶頁 HTML。

## 手機查看搶位進度（PWA）

只讀監控畫面可透過現有 Mac 的 Tailscale Funnel 提供 HTTPS 網址，手機不用安裝 Tailscale，也不用自備網域。監控服務獨立讀取 `artifacts/` 的最新正式搶位事件，沒有啟動／停止搶位或付款按鈕。各時段分別顯示查詢、重試、暫留、填表及人工接手狀態；「已暫留」不代表預約完成。

第一次設定並啟動（不會執行搶位）：

```bash
npm run monitor:setup
npm run monitor:start
```

`monitor:start` 會安裝並啟動目前使用者的 macOS 常駐服務，關閉終端或結束 Codex 工作後仍持續運作，登入 Mac 時自動啟動。接著執行：

```bash
npm run monitor:funnel
```

從手機開啟印出的 HTTPS 網址，使用 `.local/monitor-password.txt` 內的密碼登入，再加入主畫面。預設本機監控 port 為 **4174**、Funnel HTTPS port 為 **8443**，不會覆寫已被其他服務使用的 Funnel port。既有 443 服務保持原設定。密碼與雜湊設定檔都已被 Git 排除，權限為 `0600`；設定命令不會印出密碼。服務重新啟動或重設密碼後需再次登入。

之後在原本的終端照常啟動 `live`，PWA 會自動追蹤最新正式執行。`npm run monitor:status` 檢查常駐服務，`npm run monitor:stop` 停止服務並停用自動啟動，再執行 `monitor:start` 可恢復。監控服務不讀取 `config.local.json` 或公開原始診斷、個資、screenshots。頁面或程式心跳中斷會標示資料過期，不會把舊資料當成仍在執行。詳細操作、演示模式、停止單一 Funnel 入口與自訂路徑見 [MONITOR.md](docs/MONITOR.md)。

## Repository architecture

```text
src/
  cli.ts          mode 流程、warm-up、並行與人工接手
  cli-options.ts  CLI 參數及不可覆寫的 live 選項
  browser.ts      每個 slot 的獨立 Chrome／Chromium 程序
  config.ts       本機設定驗證、兩船代表人檢查
  time.ts         時區、開放 instant、可中斷 monotonic 等待
  retry.ts        Retry-After、backoff、最低查詢間隔
  scheduler.ts    各 slot 獨立 worker、一次性 action、Promise.allSettled
  safety.ts       context 網路 guard、redirect 檢查、one-shot capability
  site-rules.ts   已確認 EIPrO endpoint／資源讀取規則
  site.ts         真站日曆、availability、官方 hold action adapter
  autofill.ts     真實表單 discovery、local mappings、逐欄驗證
  customer-step.ts 當次填表、人工接手結果與選用驗證紀錄
  observed-form.ts 10/8 已觀察欄位契約與本機驗證規則版本
  readiness.ts    本機 mapping 驗證 receipt 及 live readiness
  diagnostics.ts  毫秒級事件、畫面與去敏感診斷
config/
  config.example.json
tests/            離線 unit／本機 Playwright fixture tests
docs/
  REAL_SITE.md
  MAC_CHECKLIST.md
  evidence/       公開觀察的資源清單，無 session token／個資
.github/workflows/ci.yml
```

不使用共享 session，不把某一 slot 當成另一 slot 的 fallback。

## 測試與 CI

```bash
npm test
npm run typecheck
npm run lint
npm run check
```

測試使用本機 fixture 與 fake clock，涵蓋時區換算、並行、不互相中止、未知 availability、安全 guard、redirect／一次性 hold、backoff、設定及 Autofill。CI 安裝 dependencies 後，在只開啟 loopback 的獨立 Linux network namespace 執行 `check`；不對真實 EIPrO 發送測試、建立 hold 或高頻查詢。

Cloud 上的離線測試與真站公開讀取不能代替 macOS Chrome 驗證。安裝與 browser launch、目前官方客戶表單、額外資源 allowlist、人工確認／付款／3D Secure 及開放時的真實競爭情況，都須依 [MAC_CHECKLIST.md](docs/MAC_CHECKLIST.md) 驗證；沒有成功預約保證。
