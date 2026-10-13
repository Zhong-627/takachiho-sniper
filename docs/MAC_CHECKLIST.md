# Apple Silicon Mac 驗證清單

以下按順序完成。只有 full rehearsal 與 live 能建立真實 hold，且都需要 `--confirm-reservation-side-effects`。不要為驗證而反覆占用時段。

## 1. 安裝與離線檢查

```bash
node --version
node -p process.arch
npm run setup
cp config/config.example.json config/config.local.json
npm run check
npm run doctor
```

- [ ] Node.js 至少 22，architecture 為 `arm64`。
- [ ] `setup`、tests、typecheck、lint 通過。
- [ ] 選定 `browser.channel`：已安裝 Chrome 用 `chrome`，下載的 Playwright Chromium 用 `chromium`。
- [ ] 開啟 macOS「日期與時間」自動設定時間，確認系統時鐘與可靠來源一致。
- [ ] 個資只在 `config/config.local.json`；`git status --short` 沒有出現此檔或 `.local/`／`artifacts/`。

clone 後以 `open -e config/config.local.json` 或 `code config/config.local.json` 編輯。先核對 targetDate、releaseAt、1–2 個 slots，再填 `customers[時段]` 各自的 `representativeName` 及 9 個 fields，設定兩船時代表人不同；姓／名合併須與頂層代表人一致。範例已帶 10/8 觀察的 mappings，個資值都是空白。已有 local config 時不要用 cp 覆寫，手動合併新欄位與 mappings。細節見 [乘客資料說明](CLI.md#本機個資與-autofill) 與 [表單勘查](FORM_20261008.md)。

doctor 分別報告搶位設定與填表狀態。自動模式缺少完整 fields／mappings 仍須修正；缺少近期 receipt 只提示待當次表單確認，退出碼仍為 0。人工填表可使用 `npm run doctor -- --manual-customer-form`，僅需各船代表人及正確目標設定。

## 2. 無 side effect 的真站 inspect

```bash
npm run inspect
```

- [ ] 可見瀏覽器開啟真實 EIPrO；目標日期符合 local config 的 targetDate。
- [ ] 日曆及所有設定 slots 可被辨識，各時段有自己的診斷。
- [ ] 目前未開放時，結果是 unavailable／未開始，remaining 船數沒有被誤判成 available。
- [ ] 檢查截圖、redirect、HTTP status、network／navigation latency、Cookie metadata、所有 `blocked` 診斷。
- [ ] 如有 CAPTCHA、queue 或 maintenance，保留畫面，停止自動嘗試；安全模式不會解除 guard 讓使用者建立 hold。

輸入 `q` 離開。若需檢查其它日期：`npm run inspect -- --date YYYY-MM-DD`。每次輸出保存於獨立 artifacts 目錄。

## 3. 無 hold 的 real-site rehearsal

```bash
npm run rehearsal -- --attempts 3
```

- [ ] 所有設定 slots 都開始自己的演練流程。
- [ ] 某一 slot 失敗／慢載入，另一個仍繼續並留下獨立 log。
- [ ] 確認每個 slot 顯示 available／unavailable／unknown，unknown 沒有觸發 action。
- [ ] 開放前未建立 hold，也沒有進入客戶資料頁。
- [ ] 比對 request start／end、retry delay 與 screenshot；沒有高頻 polling。

要驗證目前可預約時段的 action 規劃，使用先前 inspect 已確認的已開放日期：

```bash
npm run rehearsal -- --date YYYY-MM-DD --attempts 3
```

這個模式仍不建立 hold。安全模式的防護不會因頁面點擊或程式誤呼叫選取而解除。

## 4. 選用：一次真實 full rehearsal 與欄位驗證

**這一步會真的占用一艘船，通常約 15 分鐘。** 只有在目前有餘位且確實希望演練時執行，並非 live 的必要前置條件。沒有可預約時段時可直接準備正式模式，取得目標船位後核對當次表單。`--slot` 必須是 local config 的 slots 中一個 HH:mm，full rehearsal 每次只處理一個。

1. 在 local config 為該 slot 填入真實 `representativeName` 與 9 個 fields。若這次僅要 discovery，將 fields／mappings 明確設為 `{}`／`[]`，保留頂層代表人；不是把空白資料當作已驗證填寫。
2. 執行：

   ```bash
   npm run full-rehearsal -- --date YYYY-MM-DD --slot 10:00 --confirm-reservation-side-effects
   ```

3. 確認只有一次 hold request；成功才導向 `orders/add`。若 timeout／結果不確定，先人工檢查原頁，**不要重新執行來重試 hold**。
4. 檢查客戶頁 `form-HHmm.json`（例如 `form-1000.json`）schema，比對 10/8 的姓／名、片假名姓／名、Email、電話、地址、生日、人數與當次 DOM。`htmlRequired=false` 不代表可不填；檢查 `requiredSources`、missingObservedFields 與 HTML 限制。只有一份 08:30 表單曾勘查，設定的各日期／時段是否相同仍須確認。
5. 在 local config 使用當次確認的 `fields`／`mappings` 與自己的資料。人數 select 使用真實 option value；不要自動 check 三項確認或付款。生日格式、輸入後格式化、台灣電話／海外地址接受方式與片假名需要實測；沒有提交伺服器前不能宣稱伺服器驗證已通過。
6. 保持同一客戶頁，於 CLI 終端輸入 `f` 重新載入設定及驗證；它不會重新 hold。
7. 確認 customerFieldsVerified、9 個必要客戶欄位非空、當次選項及 HTML validity 通過，`.local/form-verification.json` v2 已由程式更新。v1 舊紀錄不能沿用，也不能因 Cloud 勘查或離線 fixture 測試手寫 receipt。
8. 如果兩時段的表單相同，把已驗證的 mappings 複製至另一個 slot，但填入該船不同代表人的實際資料。若表單不同，需要各自驗證。

- [ ] 目前 customer DOM 能辨識，所有必要欄位都清楚。
- [ ] customer page 額外 read-only 資源已確認；任何未知 script／endpoint 仍不得任意放行。
- [ ] Autofill 只碰客戶欄位，沒有輸入信用卡、OTP、CAPTCHA 或點選規約／最終確認。
- [ ] 填寫值被程式逐欄比對，但 JSONL／diagnostics 沒有客戶值或 Cookie 值。
- [ ] 瀏覽器保持開啟，使用者清楚如何人工接手與離開。

若欄位、資源或安全驗證尚未確認，標記為 Mac 待完成，保留畫面。可以在已授權 full rehearsal 中輸入 `handoff` 手動完成所需操作；handoff 後自動化停止。工具不會替使用者完成付款。輸入 `q` 只關閉，hold 釋放時間以官方為準。

## 5. Live 前最終檢查

```bash
npm run doctor
```

- [ ] doctor 輸出的 targetDate、1–2 個 slots 及台北／日本開賣時間均符合本次目標。releaseAt 必須含正確時區，customers key 與各 slot 相符；改目標方法見 [終端設定指南](CLI.md#更改預約日期與時間)。
- [ ] doctor 的 `monitorFrom` 與 `baseDelayMs` 符合需求；提前查詢須另填 `monitorFrom`，保留真實開放時間。開始時間與間隔於下次啟動生效。
- [ ] `monitorUntil` 含時區且晚於 releaseAt，doctor 顯示的台北截止時間符合需求。此值於啟動時讀取，儲存後下次啟動生效。
- [ ] 若設定兩個 slot，使用不同真實代表人，對應官方多艘船規則。
- [ ] 明確選擇自動或人工填表。自動模式填妥 fields／mappings；歷史紀錄只供參考，取得位置後仍會核對當次表單。人工模式加 `--manual-customer-form`，取得位置後輸入 `handoff` 自行填寫。
- [ ] 可見 Chrome／Chromium 沒有 CAPTCHA／queue／維護問題。
- [ ] Mac 系統時間自動同步、接電、網路穩定、禁用睡眠，不在開放前重啟或關閉終端。
- [ ] 最後一次安全 inspect／rehearsal 沒有未解決的 DOM 變動或 `blocked` 必要資源。
- [ ] 清楚知道伺服器 hold 約 15 分鐘；準備好自行處理成功頁的後續資料、信用卡與 3D Secure。

提前數分鐘啟動，保持終端開啟：

```bash
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

開賣時間取自 local config 的 `releaseAt`，開始查詢取自 `monitorFrom`（未填則沿用開賣時間）；example 的目標為 **2026-10-24**，開始查詢為 **2026-10-10 07:58 台北**、開賣時間為 **08:00 台北／09:00 日本**，監控截止為 **10:00 台北**，正常回應後等待約 **750 ms**。請以 doctor 核對當次本機日期、時段及三個時間。預熱在開始查詢前 120 秒，程式須提前啟動；已過開始查詢時間、仍在截止前時可直接啟動。開放前正常未出現時段不累積退避，正常等待會對齊開放時間；錯誤、429 及 Retry-After 仍保留退避。各 slot 獨立監控至 `monitorUntil`，沒有 80 次或固定 20 分鐘上限。成功一個不會取消另一個。僅當當次 hold 明確失敗且重新確認同一場次額滿，才回到查詢；成功或結果不明均停止該時段。成功頁保留，由你輸入 `handoff HH:mm` 後分別完成最後確認與付款。

自動模式會在第一欄填寫前檢查所有 mappings、必填客戶欄位與選項。若不符，保留客戶頁並提示人工接手；填寫中驗證失敗也會停止後續填寫。人工模式只檢查表單，不自動填任何欄位，`f` 停用。兩種模式都保留每次嘗試只有一次 hold 的防護；未確認失敗及額滿不得重試。

## 尚無法提前證明的事項

真實開放瞬間的餘位、競爭、server latency、queue、CAPTCHA、信用卡與 3D Secure 成功只能由正式當下與人工操作確認。毫秒級 log 可分析發出時機及兩個 flow 的進展，不構成成功預約保證。
