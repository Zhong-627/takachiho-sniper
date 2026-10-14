# 實際驗證紀錄

## 2026-10-14：修正分鐘精度截止時間漏發通知

使用者實測台灣 17:08 截止後未收到通知。正式紀錄確認 17:08:00.002 已到截止、17:08:00.401 所有時段自動化已結束；但 `run_started` 的合法排程 `2026-10-14T17:08+08:00` 沒有秒數，監控投影的解析器只接受含秒格式，將 `monitorUntil` 變為 null，因此未建立摘要，並非已送往推播服務後未送達。

解析器已接受分鐘或秒精度，仍要求有效日期、時分秒範圍及明確時區。新增正負 offset／Z 的合法格式與無效邊界測試，另以暫存事件檔覆蓋 `run_started → 截止 → 所有時段完成 → 單次摘要` 的完整資料流程；先前摘要測試只使用含秒排程，漏掉了手機可送出的格式。

相關五個測試檔 **112 項測試全部通過**，型別、lint 與編譯通過。另以這次正式事件檔和編譯後程式在隔離的時鐘與暫存推播狀態中重播，捕獲一則含 2026-10-28、08:30 日本乘船時段及 17:08 台灣截止時間的正確摘要，重複觀察不再發送。依使用者選擇，本次不補送舊摘要，驗證均使用假傳送器，手機實際收訊留待下次監控截止確認。

修正後已重新載入既有背景控制台，確認程序 running、本機健康檢查正常。該次歷史任務僅保存基準紀錄，沒有收件者且嘗試傳送次數為零，符合不補送的選擇。

另確認暫留通知沒有相同的排程解析依賴：成功暫留使用事件的數字 `epochMs` 設定 `heldAt`，不以截止時間作為傳送條件。新增六個事件檔整合案例，覆蓋三種暫留成功事件與 `+08:00`／Z 分鐘精度排程；即使排程投影欄位為 null，仍立即通知，後續轉為人工處理仍每三秒提醒，按停止提醒後停止。相關四個測試檔 **99 項全部通過**，型別及 lint 通過。這次使用假傳送器，沒有建立官方暫留或發送真實手機通知。

## 2026-10-14：監控截止後的完整摘要通知

本次至少一個時段實際監控到截止時，等待各時段截止前已發出的查詢、搶位與填表操作結束，再將乘船日期、台灣截止時間及各時段最後結果合併通知一次。已暫留仍提示待確認付款；結果不明保留人工確認狀態。整次監控提前手動停止、全部時段在截止前結束及首次載入的舊歷史不發截止摘要，已送出的摘要跨重啟保留去重紀錄。截止摘要沿用已啟用的裝置通知，不加入每 3 秒的暫留持續提醒。

PWA 的通知標題與說明已涵蓋暫留提醒及截止摘要，應用外殼快取升至 v9。本次未發送真實推播、建立官方船位或進行 iPhone 鎖屏實測。

macOS arm64／Node.js 22.16.0：`npm run check` 的型別、lint 與 **464 項測試（27 個 suites）全部通過，無跳過**；`npm run build` 成功。新增截止摘要及狀態案例涵蓋晚到 hold／autofill、截止後先交接、人工停止、已結束程序、多裝置單次傳送、舊紀錄分段重播不補推、關閉期間成功送出的持久化、重啟去重與失敗重試、Retry-After（含小數秒）、三次／兩分鐘上限及 v1／v2 推播資料遷移。首次完整檢查被沙箱的 Chromium／localhost／Unix socket 權限限制阻擋，允許本機離線測試後重跑通過；測試推播均使用假傳送器與暫存資料。

已重新載入既有 macOS 背景控制台，確認新程序為 running、本機健康檢查正常且登入後自動啟動仍啟用。手機需重新登入以取得新的控制台工作階段。

## 2026-10-13：每 3 秒持續提醒與停止提醒

確認暫留後立即通知，之後每 3 秒持續發送，直到在控制台按「停止提醒」。提醒與各裝置退避時間會保存；服務重啟後仍沿用，舊版的一次性通知不會轉成持續提醒。停止只處理按下時畫面列出的提醒，之後新搶到的時段仍會啟動；停止不操作搶位 worker 或預約瀏覽器。推播傳送不占用停止命令的狀態鎖，同一裝置的請求不重疊，429 尊重 Retry-After，短 TTL 與固定推播 Topic 避免補送大量過時通知。

完整 `npm run check` 的型別、lint 與 **429 項測試（26 個 suites）全部通過，無跳過**；`npm run build` 成功。推播測試 22 項涵蓋 3 秒邊界、超過原 120 秒上限、自主計時、重啟、舊狀態升級、並行停止、慢速裝置、跨時段冷卻與新時段提醒。瀏覽器與 API 測試涵蓋登入／來源邊界、停止按鈕、離線、登入過期及舊回應競態；手機與桌面截圖已檢查按鈕可見及水平溢位。測試使用假的推播傳送器與離線預約資料，沒有發送真實推播或建立船位。

既有背景控制台已重新載入並確認正常回應；提供新版停止按鈕及 v8 Service Worker，未登入的推播狀態仍回傳 401。使用者已確認單則測試通知有聲音；密集通知在 iPhone 鎖屏時的實際提醒效果仍需手機確認，測試結果不代表每則都會震動或精確在 3 秒內送達。

## 2026-10-13：修正過期紀錄鎖住日期時段設定

實際控制台回傳 `worker:null`，卻因數小時前已停止的紀錄仍為 `stale` 而判定 `externalRun:true`，鎖住整個設定區。修正為對已過截止、沒有暫留或待確認結果的紀錄，另檢查本專案 Node CLI／worker 是否仍存在；確認沒有程序才解除鎖定。大型舊 log 尚在逐段重播查詢階段時也採相同判斷。有效程序、未明 hold、失聯 lock 與未確認啟動仍保留保護。

相關控制台 12 項、程序辨識 13 項及瀏覽器 9 項回歸測試通過；型別、lint 與 build 通過。在現有 HTTPS PWA 的手機尺寸瀏覽器實測，日期可以編輯，修改後儲存按鈕可用。實測只修改未儲存的瀏覽器草稿，沒有更動本機設定或啟動搶位；背景服務已重新載入修正。

## 2026-10-13：PWA 控制與 iPhone 推播

新增日期／單雙時段與資料組設定、共用搶位 runner、獨立 worker、私有 socket、CLI／前端共用獨占鎖、停止保留頁面、各時段 Mac handoff、明確結束瀏覽器，以及標準 Web Push。目標選擇另存，不覆寫本機個資；啟動要求攜帶已確認設定，跨服務重啟的啟動意圖及 runId 用於辨識同一次操作。設定後來損壞時，已開啟的 worker 仍可停止、交接或結束。

macOS／Node.js 22.16.0：完整 `npm run check` 的型別、lint 與 **351 項測試（24 個 suites）全部通過，無跳過**；`npm run build` 成功。本機瀏覽器與 Unix socket 測試需要允許測試程序在沙箱外執行。所有預約測試使用離線 HTML 或假的 runtime，推播測試注入假的傳送器，沒有向官方建立船位、填真實個資或發送真實通知。

新增驗證涵蓋單／雙時段與資料組重配、不同代表人、過期命令、設定變更與並行啟動、跨程序獨占鎖、跨控制台重啟的未確認啟動、已發出的 hold 停止後保留、獨立交接、API 登入／來源邊界、iPhone 權限操作時機、失敗訂閱回復、VAPID 輪替、失效訂閱清理、人工填表狀態下的暫留通知、歷史資料基線、通知去重／重試／TTL／快照合併。手機與桌面截圖已檢查排版及水平溢位。

現有背景控制台已重新載入；未登入的 `/api/control` 與 `/api/push` 回傳 401，新的 PWA 外殼及 manifest 正常。iPhone 真實鎖屏送達與系統通知設定仍需在你的主畫面 PWA 按「測試通知」確認。

2026-10-07 在 Linux x64 Cloud 使用系統 Chromium 151 執行實際 EIPrO 網站的安全 inspect 及三輪 rehearsal，兩者退出碼均為 0。未使用個資，未送出 hold 或客戶頁請求。

- 日表示、2026-10-26、10:00／10:30 均正確識別。
- 兩時段每輪均為 `unavailable`：尚未開放的官方旗標禁止預約，即使剩餘數為 15 也不執行動作。
- 每個流程有獨立 Chrome/Chromium process、context、cookie jar、計時與 retry。
- 完整 runtime artifacts 有 JSONL、cookie metadata、DOM、navigation timing、兩時段 screenshots；未追蹤於 Git。
- [真站 rehearsal 摘要](evidence/real-rehearsal-result.json)、[目標時段實際旗標](evidence/target-availability.json)、[實際日曆截圖](evidence/calendar-2026-10-26.png) 可供檢查。網路延遲只代表這次 Cloud 環境，不代表開賣時延遲。

驗證過程發現並修正 toolbar 容器高度、日期選單初始化、官方 `bindCalendar` 動態改寫 `data-target_selector`、以及 iframe navigation 日誌的問題。穩定 selector 使用實際 `#mainForm` 父層。CLI 透過 `tsc` 編譯後的 Node.js 執行，避免 transpiler helper 出現在瀏覽器函式序列化中。

自動化檢查：`npm run check` 執行 typecheck、lint、159 項 Vitest 測試，全部通過；`npm run build` 驗證可產出執行檔。瀏覽器測試使用 localhost 或攔截的官方形狀 fixture，涵蓋一次性 hold 成功證明、客戶 Autofill、信用卡／OTP 保持空白、安全模式意外呼叫仍被阻擋、redirect、429、未知 availability、時間、獨立並行及 receipt。

上述 10/7 run 沒有真實 hold 或客戶頁。當日自動審查曾拒絕真實時段點擊，後續使用公開 source 與零 hold 讀取；這是歷史紀錄，不是 10/8 UI 勘查的結果。Mac 仍需依 [檢查清單](MAC_CHECKLIST.md) 驗證 repo adapter、當次表單、額外資源及 Autofill，未知資源不能擴大成任意 GET allowlist。

GitHub 推送目標已指定為 [Zhong-627/takachiho-sniper](https://github.com/Zhong-627/takachiho-sniper)。GitHub Actions workflow 已建立，測試階段只有 loopback 網路。上述通過紀錄來自本機 Cloud 驗證，尚未確認 GitHub Actions 執行結果；推送後請在 repository 的 [Actions 頁面](https://github.com/Zhong-627/takachiho-sniper/actions) 檢查狀態。專案附鎖定相依套件、CI、文件及 Git history，可依 README 從 GitHub clone。

## 2026-10-08 更新範圍

另一次已授權 Cloud 官方 UI 勘查成功暫留 1 艘並讀取表單，詳見 [紀錄](FORM_20261008.md)。未執行本 repo adapter、填入個資、勾同意、提交或付款。沒有 Mac Autofill／receipt，不能把 UI 成功計作軟體已實測成功。

新增 `observed-form` 契約、9 欄 mappings、必要欄位來源、姓／名與代表人一致性、三個 dummy checkbox 人工防護及 receipt v2。離線 fixture 從去除個資的 metadata 重建，不保存完整真站 HTML，也未模擬未知生日格式化或伺服器驗證。程式不放寬未知欄位、付款或額外資源 allowlist；正式 adapter 與 polling 行為維持原設計。

2026-10-08 Linux x64／Node.js 24.19.0，最後一次 `npm run check` 的 typecheck、lint 與 **185 項測試（13 個 suites）全部通過，無跳過**；另執行 `npm run build`。本機 full Chromium 初次啟動被環境的 Unix socket 權限拒絕，改用同版 Playwright Chromium Headless Shell 141 執行完整離線測試，沒有修改 Mac browser 設定或降低 guard。重現 Cloud 檢查的環境變數如下，Mac 正常安裝不需這個路徑：

```bash
PLAYWRIGHT_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell npm run check
npm run build
```

新增 25 項表單測試及 1 項 receipt 版本測試；涵蓋 raw required=false、9 個值非空、地址／人數 mapping 缺漏、消失／改型／唯讀／重複 control、付款語義優先、三個確認保持人工、精確人數 value、HTML 限制 metadata、姓／名與代表人一致性、舊 receipt 失效。所有新增填寫使用假資料與本機 HTML；沒有再向 EIPrO 建立 hold 或生成真實本機 receipt。本紀錄不等於 GitHub Actions 已通過，CI 以提交後實際狀態為準。

## 2026-10-08：預約目標改由 local config 指定

日期、開賣時間、1–2 個 HH:mm 時段及各船個資改由 local config 讀取，移除原本正式模式固定日期、開賣 instant 與 10:00／10:30 的限制。三個目標欄位必填，保留日期／時區／時段格式、唯一時段、不同代表人、已驗證 mappings、可見瀏覽器及每時段單次 hold 防護。執行中 f 仍可改個資與 mappings；若有效日期、開賣 instant 或時段集合已變更，會拒絕填寫原表單。

Linux x64／Node.js 24.19.0／Playwright Chromium Headless Shell 141：`npm run check` 的 typecheck、lint 與 **206 項測試（13 個 suites）全部通過，無跳過**；`npm run build` 成功。新增 21 項測試，涵蓋必填目標、HH:mm 邊界、漏改 customers key、任意時段的代表人及 readiness、開賣時間等待、執行中目標變更與 CLI 覆寫限制。離線瀏覽器整合案例使用 2026-11-03、09:15／11:45 的合成日曆，兩個流程各取得一次受保護 fixture hold 並使用各自假資料，信用卡／OTP 空白、客戶表單未提交，再次 hold 仍被拒絕。此日期／時段僅為測試資料，不表示官方實際提供。

編譯後的 doctor 另以暫存 config 驗證單／雙自訂時段，正確輸出乘船日期、時段及台北開賣時間，缺少真實 receipt 時維持未就緒。編譯後 full-rehearsal 接受 09:15，再由非互動終端防護停止，沒有啟動瀏覽器。所有測試使用離線 fixture／暫存資料，沒有操作真站或建立新的真實驗證紀錄。Mac Autofill 與正式 availability 仍須依檢查清單確認。

## 2026-10-08：搶位啟動與歷史填表紀錄分開

歷史 receipt 改為參考提示。缺少、舊版、過期或 mapping 不相符的紀錄不再阻止 live 啟動；自動模式的本機欄位／mapping 完整性、代表人一致性、不同代表人、可見瀏覽器與 side-effect 確認仍須通過。新增 `--manual-customer-form`（live／doctor），保留代表人與目標檢查，客戶頁只檢查、不自動填寫，`f` 停用。

每次自動填表在第一欄寫入前檢查全部 mappings、必填客戶欄位與選項；未知必填欄位或缺少 mapping 時整批停止。填寫中的欄位變更、值不符或 HTML validity 失敗也停止後續寫入。結果未通過時明確回報 manual 並提示 handoff，仍保留已取得頁面；同一時段不重新 hold，另一時段獨立繼續。成功填寫可更新 live／full rehearsal 的歷史紀錄，並行寫入保留兩組不同 mapping 的紀錄；紀錄寫入失敗不丟棄已取得的位置。

macOS arm64／Node.js 22.16.0／Playwright Chromium 141：`npm run check` 的型別、lint 與 **218 項測試（14 個 suites）全部通過，無跳過**。新增的離線瀏覽器整合案例確認無 receipt 也可準備兩組 live flow，第一組 mapping 指向付款欄位時沒有填入任何個資、只建立一次 fixture hold，第二組正常完成客戶欄位填寫；信用卡／OTP 保持空白。其他案例涵蓋人工模式零寫入、未對應的必填欄位、填寫中新增欄位、HTML 失敗後停止、瀏覽器錯誤去敏感與選用紀錄寫入失敗。

## 2026-10-09：持續監控與確認額滿後恢復

live 新增必填的 `monitorUntil` 絕對截止時間，取消 80 次／預設 20 分鐘及開賣後 20 分鐘的啟動限制。普通額滿讀取沿用固定 base delay 與 jitter，429／錯誤仍保留退避。收到匹配的 HTTP 2xx 字串 `0` 後，還須確認當次官方結果常數、原日曆頁及同一場次的新 `is_full=true`，才能清除該次失敗能力並回到監控。其他回應、成功及 full rehearsal 不能重送。

macOS arm64／Node.js 22.16.0：完整 `npm run check` 的型別、lint 與 **238 項測試（14 個 suites）全部通過，無跳過**。新增測試涵蓋持續 1301 次讀取且超過 20 分鐘、原頻率保持、截止後抵達的可預約回應不觸發 hold、截止前準備但截止後不派送、手動取消、Retry-After、明確拒絕後額滿再釋出、未知／仍有餘位／場次變更／結果常數變更不得恢復、成功後禁止再送及演練保持一次性。本次瀏覽器測試全部使用離線 fixture，沒有新增真站暫留。

編譯後 `npm run doctor` 使用本機設定（2026-10-23、10:00／10:30，2026-10-09 08:00 台北開賣）退出碼為 0，顯示搶位設定通過、兩組自動填表待當次表單確認。測試中的所有驗證紀錄只寫入測試暫存路徑，沒有冒充真站紀錄。這次程式修改未執行額外真實暫留或付款；正式表單與伺服器接受情況仍取決於當次網站。

## 2026-10-12：07:58 提前查詢與 750 ms 間隔

新增選填 `monitorFrom`，將開始查詢時間與 `releaseAt` 分開，舊設定未填時仍從開放時間開始。本機目標為 2026-10-26 的日本時間 11:00／11:30，台北 2026-10-12 07:58 開始查詢、08:00 開放、10:00 截止，正常回應後基礎等待改為 750 ms；個資及其他設定值保留。預熱改以開始查詢時間為基準。

有效且無錯誤的日曆回應在開放前尚未列出時段時，維持普通等待，不累積 20 秒退避；正常等待會對齊開放時間，跨過開放時間才完成的正常查詢會立即再查一次，沒有並行重疊請求。未知、錯誤、開放後尚未出現時段與 429 繼續退避；`Retry-After` 不因開放而縮短。尚未出現時段仍是 unknown，不能觸發 hold。

macOS arm64／Node.js 22.16.0：型別檢查、lint、編譯與 doctor 通過；完整 **251 項測試（14 個 suites）全部通過，無跳過**。13 項新增測試涵蓋 07:58 起至 08:00 的 161 輪模擬讀取、750 ms 等待、跨開放時間的定時與延遲回應、錯誤及 Retry-After 不被縮短、有效未列出時段與損壞回應的區分、開始時間驗證及執行中設定保護。第一次瀏覽器測試因 macOS 沙箱阻擋 Chromium／localhost 而無法啟動，允許本機離線測試執行後完整重跑通過。瀏覽器測試只使用 localhost 或攔截的 fixture，沒有新增真實船位暫留。
