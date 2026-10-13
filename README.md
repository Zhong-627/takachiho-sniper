# 高千穗峽划船預約工具

在手機設定乘船日期與時段，由 Mac 自動查詢高千穗峽船位；取得船位後收到通知，再到 Mac 完成確認與付款。

## 可以做什麼

- 同時監控一至兩個時段，各自搶位，成功一個仍會繼續另一個。
- 從手機設定目標、開始或停止查詢，隨時查看進度。
- 暫留船位後協助填寫乘客資料，也可選擇自行填寫。
- 手機可加入主畫面，啟用通知後接收暫留提醒。

**「已暫留」尚未完成預約，最後確認與付款需要你在 Mac 操作。**

## 快速開始

### 1. 在 Mac 安裝

需要 Apple Silicon Mac、原生 arm64 的 Node.js 22 以上及 Git。手機控制台另需在 Mac 安裝並登入 Tailscale，確認終端可執行 `tailscale` 且帳號可使用 Funnel；手機不用安裝 Tailscale。

```bash
git clone https://github.com/Zhong-627/takachiho-sniper.git takachiho-reservation
cd takachiho-reservation
npm run setup
```

安裝程序會一併下載需要的瀏覽器。

### 2. 準備乘客資料

首次使用時，建立並開啟本機設定檔。已有 `config/config.local.json` 時，直接開啟編輯，請勿重新複製覆寫。

```bash
cp config/config.example.json config/config.local.json
open -e config/config.local.json
```

在 `customers` 的各組資料填入代表人姓名（`representativeName`）及乘客欄位（`fields`），包含姓名、片假名、Email、電話、地址、生日及乘客人數。範例提供兩組資料；若要預約兩艘船，請使用不同代表人。

個資只填在本機設定檔，不要填進範例檔或提交到 Git。欄位填法見 [乘客資料說明](docs/CLI.md#本機個資與-autofill)。

### 3. 開啟手機控制台

在 Mac 的專案目錄執行：

```bash
npm run monitor:setup
npm run monitor:start
npm run monitor:funnel
```

從手機開啟終端顯示的 HTTPS 網址，使用 Mac 上 `.local/monitor-password.txt` 內的密碼登入。可在 Mac 用以下命令開啟密碼檔：

```bash
open -e .local/monitor-password.txt
```

控制台會在背景持續運作，關閉終端也可使用。啟動控制台後，還需要在手機按「開始搶位」才會執行搶位。

## 用手機搶位

1. 到「設定」選擇乘船日期、一或兩個時段，以及各船的乘客資料組。
2. 核對開始查詢、開賣與截止時間，按「儲存設定」。乘船日期與時段使用日本時間，排程使用台灣時間；更換日期會重新帶入預設排程，請再次確認。
3. 按「開始搶位」，到「進度」查看各時段狀態。啟動後關閉手機畫面不會停止搶位。
4. 取得船位後，按該時段的「交接到 Mac」，再到 Mac 原本的預約瀏覽器完成資料、確認與付款。

若要接收通知，先將控制台加入手機主畫面，再到「設定」按「啟用通知」及「測試通知」，確認手機實際收得到。

## 使用時請留意

- Mac 必須保持開機、連網，Tailscale 也須保持運作；建議接上電源，並準備好在取得船位後接手。
- 船位與實際開放情況以 [官方預約網站](https://eipro.jp/takachiho1/) 為準，工具無法保證搶位成功。
- 遇到表單變更或需要人工驗證時，請到 Mac 檢查並接手。
- 「停止查詢，保留頁面」會保留預約瀏覽器；若要更換目標重新執行，須先「結束並關閉瀏覽器」。關閉瀏覽器不代表官方立即釋放暫留船位。
- 手機設定的目標與終端模式分開保存，使用終端前請另行核對本機設定。

## 也可以用終端操作

先依 [終端操作指南](docs/CLI.md#更改預約日期與時間) 設定本次日期、時段與排程，再檢查並啟動：

```bash
npm run doctor
caffeinate -dimsu npm run live -- --confirm-reservation-side-effects
```

取得船位後，在同一終端輸入 `handoff`，再到瀏覽器完成預約。使用終端模式時，請保持該終端與預約瀏覽器開啟。

## 詳細文件

- [手機控制台指南](docs/MONITOR.md)：通知、服務管理、升級及常見狀態。
- [終端操作與技術參考](docs/CLI.md)：完整設定、演練、填表與開發資訊。
- [Mac 檢查清單](docs/MAC_CHECKLIST.md)：安裝後及正式執行前的檢查。
- [真站觀察紀錄](docs/REAL_SITE.md)與[驗證紀錄](docs/VALIDATION.md)：已確認的流程及驗證範圍。
