# 手機搶位進度 PWA

架構：正式 CLI 非同步寫入事件 → 獨立 Node.js 監控服務讀取事件 → Tailscale Funnel → 手機 PWA。搶位原有的 Chrome／終端流程不變；監控沒有搶位、交接或付款控制 API。

## 設定與開始使用

在專案根目錄執行：

```bash
npm run monitor:setup
npm run monitor:start
```

setup 使用密碼學亂數產生登入密碼，保存至 `.local/monitor-password.txt`，僅將 scrypt 雜湊與 salt 保存至 `.local/monitor-auth.json`。兩檔權限 `0600`，`.local/` 已排除 Git；終端不顯示密碼。不會覆寫已存在的有效登入設定。

`monitor:start` 安裝 `~/Library/LaunchAgents/com.takachiho.monitor.plist` 並啟動目前使用者的 macOS 常駐服務。它使用專案的 Node.js 程式與本機登入設定，關閉終端或結束 Codex 工作後仍持續運作，登入 Mac 時會自動啟動；只讀監控程序異常退出後，macOS 會重新啟動它。服務記錄存放在 `.local/monitor-service.log`，不記錄密碼或搶位個資。

接著執行：

```bash
npm run monitor:funnel
```

命令先確認本機提供的是監控服務，並檢查 Funnel 設定。預設增加 **8443 → 127.0.0.1:4174** 入口；保留現有其他 port，不使用 `funnel reset`。如果 port 已被其他服務占用，命令會停止，請選 443、8443 或 10000 中另一個可用 port。

檢查或停止常駐服務：

```bash
npm run monitor:status
npm run monitor:stop
```

`monitor:stop` 只停止本專案的監控，並停用登入 Mac 時的自動啟動；再次執行 `monitor:start` 會恢復。原本的 `npm run monitor` 保留為前景模式，須保持該終端開啟，不能與同 port 的常駐服務同時執行。

手機開啟命令印出的 HTTPS URL，輸入密碼後登入。iPhone 在 Safari 使用「分享 → 加入主畫面」；Android 可使用瀏覽器的安裝／加入主畫面功能。網頁也可以直接使用，手機無需安裝 Tailscale。

在原本的搶位終端照常啟動：

```bash
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

監控服務不會自行啟動 live。Mac、Tailscale、監控服務與原搶位終端都須保持運作。手機離開頁面、切換網路或關閉 PWA，不會停止搶位。Mac 睡眠或斷網時，手機無法取得新狀態；畫面會標示連線中斷，重新開啟後同步最新資料。

## 狀態意義

每時段獨立顯示等待／預熱、查詢、重試、暫留、人工處理、停止與截止。查詢次數不是成功機率，沒有完成百分比。

- **已暫留／待人工確認付款**：官方客戶頁已就緒，但尚未完成預約。
- **需要人工處理**：可能包含表單、網站異常或人工驗證；詳細診斷與操作仍在 Mac。
- **暫留結果待確認**：回應不明，不能視為成功或自行再次搶位。
- **已交由人工操作**：僅代表 `handoff`，不代表確認或付款完成。
- **資料已過期**：35 秒沒有正式程式心跳；原終端仍可能開著，請回 Mac 檢查。
- **執行已結束**：保留最後狀態供查看，不宣稱目前仍有有效 hold。

頁面區分監控服務連線與搶位程式心跳。CLI 每 10 秒寫入心跳，即使等待開賣或取得船位後停在人工操作終端，也能辨識程序仍在運作。新增版本之前執行的舊 log 沒有心跳，超過新鮮度期限會顯示資料過期。新版本只能監控重新啟動後的程序，不能替既有程序補入心跳。

監控自動選最新的正式 `live` 執行；inspect、rehearsal、full-rehearsal 不會取代它。首次使用若尚無正式紀錄，畫面顯示等待搶位程式。原 CLI 設定自訂 `artifactsDir` 時，監控需指定相同目錄：

```bash
npm run monitor:start -- --artifacts-dir /absolute/path/to/artifacts
```

## 登入與資料範圍

Funnel 的 HTTPS URL 是公共入口，API 仍需登入。Cookie 使用 HttpOnly、Secure、SameSite=Strict，登入有效期最多 30 天；服務重啟會使既有登入失效。登入請求有節流，短時間大量嘗試會暫時受到限制。

PWA 只接收白名單欄位：目標日期、時段、階段、查詢次數、回應時間、重試／截止／心跳時間與固定事件說明。原始 log、錯誤訊息、檔案路徑、網址、個資與截圖不提供給前端。Service Worker 只快取應用外殼，不快取 API、登入請求或搶位狀態。離線或 Tunnel 暫時回傳 502／503 時，已造訪過的裝置會使用正常的快取介面並顯示連線提示，不能查詢新進度。

重設密碼後，停止並重新啟動監控服務：

```bash
npm run monitor:setup -- --reset-password
npm run monitor:stop
npm run monitor:start
```

停止監控服務不影響搶位程式。若要關閉這個公開入口，只關閉本專案使用的 port（依實際設定調整）：

```bash
tailscale funnel --https=8443 off
```

不要使用 `tailscale funnel reset`，它會清除其他服務設定。

## 離線演示與自訂 port

```bash
npm run monitor:demo -- --local-http --port 4184
```

在 Mac 開啟 `http://127.0.0.1:4184`。此模式有「演示資料」標記，只產生模擬狀態，不讀正式搶位紀錄，不操作真站。`--local-http` 只允許本機 Host 的 HTTP 登入，不能透過 Funnel 使用。

正式服務需要 HTTPS 登入；預設本機 URL 用於檢查服務是否已啟動，手機請使用 Funnel URL。自訂 port 時兩端需一致：

```bash
npm run monitor:start -- --port 4184
npm run monitor:funnel -- --port 4184 --https-port 10000
```

也可用 `--auth-file` 指定另一份登入設定，但 setup、serve／service-start、funnel 必須使用同一路徑。常駐服務只安裝一份；使用新參數執行 `monitor:start` 會更新本專案的服務設定。

## 驗證

`npm run check` 涵蓋狀態轉換、資料白名單、增量 log／未完成行／檔案切換、登入／Cookie／節流、跨來源請求、未登入 API、SSE 與靜態路徑限制。瀏覽器驗證使用本機合成資料，不建立官方船位。
