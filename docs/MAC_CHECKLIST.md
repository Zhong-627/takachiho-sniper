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

初次 doctor 可能提示還沒有 customer mappings／full rehearsal receipt。這表示尚未具備 live readiness，先完成以下真站流程。

## 2. 無 side effect 的真站 inspect

```bash
npm run inspect
```

- [ ] 可見瀏覽器開啟真實 EIPrO；目標日期為 2026-10-26。
- [ ] 日曆及 10:00、10:30 可被辨識，兩個時段有各自的診斷。
- [ ] 目前未開放時，結果是 unavailable／未開始，remaining 船數沒有被誤判成 available。
- [ ] 檢查截圖、redirect、HTTP status、network／navigation latency、Cookie metadata、所有 `blocked` 診斷。
- [ ] 如有 CAPTCHA、queue 或 maintenance，保留畫面，停止自動嘗試；安全模式不會解除 guard 讓使用者建立 hold。

輸入 `q` 離開。若需檢查其它日期：`npm run inspect -- --date YYYY-MM-DD`。每次輸出保存於獨立 artifacts 目錄。

## 3. 無 hold 的 real-site rehearsal

```bash
npm run rehearsal -- --attempts 3
```

- [ ] 10:00、10:30 都開始自己的演練流程。
- [ ] 某一 slot 失敗／慢載入，另一個仍繼續並留下獨立 log。
- [ ] 確認每個 slot 顯示 available／unavailable／unknown，unknown 沒有觸發 action。
- [ ] 開放前未建立 hold，也沒有進入客戶資料頁。
- [ ] 比對 request start／end、retry delay 與 screenshot；沒有高頻 polling。

要驗證目前可預約時段的 action 規劃，使用先前 inspect 已確認的已開放日期：

```bash
npm run rehearsal -- --date YYYY-MM-DD --attempts 3
```

這個模式仍不建立 hold。安全模式的防護不會因頁面點擊或程式誤呼叫選取而解除。

## 4. 一次真實 full rehearsal 與欄位驗證

**這一步會真的占用一艘船，通常約 15 分鐘。** 選擇你確實有意驗證的一個目前可預約時段；日／時間先用安全 inspect 確認。工具接受 10:00 或 10:30，full rehearsal 每次只處理一個。

1. 在 local config 為該 slot 填入真實 `representativeName`。首次可讓 fields／mappings 保持空。
2. 執行：

   ```bash
   npm run full-rehearsal -- --date YYYY-MM-DD --slot 10:00 --confirm-reservation-side-effects
   ```

3. 確認只有一次 hold request；成功才導向 `orders/add`。若 timeout／結果不確定，先人工檢查原頁，**不要重新執行來重試 hold**。
4. 檢查客戶頁 `form-1000.json`／`form-1030.json` schema。確認網站實際要求的姓名、フリガナ、Email、電話、人數及其它欄位。記錄提供的唯一 selector、select 的 optionValue 與 required，避免猜測。
5. 在本機設定新增 `fields` 與 `mappings`，輸入值及 DOM 已確認的 selector。設定 `select` 需使用實際 option value，不能只填顯示文字。check mapping 使用 `"true"`／`"false"` 字串，且不可用於同意規約／最後確認。
6. 保持同一客戶頁，於 CLI 終端輸入 `f` 重新載入設定及驗證；它不會重新 hold。
7. 確認 customerFieldsVerified、必要客戶欄位及 HTML validity 通過，`.local/form-verification.json` 已更新。
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

- [ ] targetDate 為 2026-10-26，releaseAt 為 `2026-10-12T09:00:00+09:00`，slots 完整包含 10:00 與 10:30。
- [ ] 兩個 slot 使用不同真實代表人，對應官方多艘船規則。
- [ ] 兩個 slot 的 local mappings 在 live 前 7 天內通過 full rehearsal，receipt 與當前 mappings／欄位 keys 一致。
- [ ] 可見 Chrome／Chromium 沒有 CAPTCHA／queue／維護問題。
- [ ] Mac 系統時間自動同步、接電、網路穩定、禁用睡眠，不在開放前重啟或關閉終端。
- [ ] 最後一次安全 inspect／rehearsal 沒有未解決的 DOM 變動或 `blocked` 必要資源。
- [ ] 清楚知道伺服器 hold 約 15 分鐘；準備好自行處理兩頁後續資料、信用卡與 3D Secure。

提前數分鐘啟動，保持終端開啟：

```bash
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

正式時間為 **2026-10-12 08:00:00 台北／09:00:00 日本**。兩個 slot 各自嘗試；成功一個不會取消另一個。任一 slot 一旦派送 hold，就不會重新派送，即使回應不確定。兩頁成功均保留，由你輸入 `handoff` 後分別完成最後確認與付款。

## 尚無法提前證明的事項

真實開放瞬間的餘位、競爭、server latency、queue、CAPTCHA、信用卡與 3D Secure 成功只能由正式當下與人工操作確認。毫秒級 log 可分析發出時機及兩個 flow 的進展，不構成成功預約保證。
