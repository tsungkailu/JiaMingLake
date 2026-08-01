# jiaminglake-api（讓 GitHub Pages 也能上傳照片）

GitHub Pages 只能放靜態檔案，沒有任何後端可以接收上傳、寫檔案。
這支 Cloudflare Worker 就是那個「後端」：它收到瀏覽器送來的照片/文字後，
改用 GitHub 的 API 把檔案直接寫回你的 GitHub repo（新增 `photos/xxx.webp`、
更新 `waypoint.json` 與 `waypoint-data.js`），寫回去之後 GitHub Pages 會自動重新部署。

網頁上「新增照片、編輯照片、刪除照片、編輯地標、拖曳座標、貼 Google Drive
連結」這幾個功能，本機測試時都是打 `server.js`；部署後在 GitHub Pages 上，
會改打這支 Worker（`jiaminglake.js` 裡的 `resolveApiUrl()` 已經處理好切換邏輯，
你不用再改前端程式碼，只要把下面步驟 5 產生的網址填進 `CLOUD_API_BASE` 常數）。

> ⚠️ 這支 Worker **沒有做任何驗證**（你先前確認過可以接受公開），
> 也就是任何人只要知道這個 Worker 網址，都可以幫你的 repo 新增/修改/刪除照片與地標資料。
> 如果之後想加一道簡單密碼，之後可以再補。

> ℹ️ 寫入方式：每次修改都是一次完整的 compare-and-swap：
>
> 1. 先取得分支目前的 commit SHA
> 2. **固定用這個 SHA** 讀 `waypoint.json` 與 `waypoint-data.js`
> 3. 套用修改
> 4. 照片檔案 + 兩個資料檔打包成**同一個 git commit**，parent 就是步驟 1 的 SHA
> 5. 更新分支時要求 fast-forward，失敗（代表期間有別的請求先寫入了）就整個從步驟 1 重來
>
> 步驟 2 一定要用 commit SHA 而不是分支名稱 `main`：用分支名稱讀時 GitHub Contents API
> 會走 CDN 快取，剛寫入後短時間內可能讀到舊內容，導致同一次請求裡兩個資料檔讀到不同版本，
> 然後把「一份新、一份舊」的不一致狀態寫回 repo（曾經因此在 `waypoint.json` 留下一筆
> 指向已刪除檔案的孤兒照片記錄）。commit SHA 指向的內容不可變，沒有這個問題。

## 需要準備的東西

1. 一個 Cloudflare 帳號（免費）：https://dash.cloudflare.com/sign-up
2. Node.js（你已經有了）
3. 一個 GitHub **fine-grained personal access token**：
   - 到 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
   - Repository access：只勾選這個嘉明湖專案的 repo（不要選 All repositories）
   - Permissions → Repository permissions → **Contents: Read and write**
   - 其餘權限都不用給
   - 產生後複製起來，等一下要設成 Worker 的 secret（這組 token 不要貼到程式碼或任何檔案裡）

## 部署步驟

在這個 `cloudflare-worker/` 資料夾底下執行：

```bash
# 1. 安裝 wrangler (Cloudflare 的部署工具)
npm install -g wrangler

# 2. 登入 Cloudflare（會開瀏覽器授權）
wrangler login

# 3. 編輯 wrangler.toml，把 GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH
#    換成你自己的 GitHub 帳號、repo 名稱、分支（通常是 main）

# 4. 設定 GitHub token 為 secret（會提示你貼上 token，貼上後按 Enter）
wrangler secret put GITHUB_TOKEN

# 5. 部署
wrangler deploy
```

部署成功後，終端機會印出一個網址，長得像：

```
https://jiaminglake-api.<你的-subdomain>.workers.dev
```

把這個網址複製起來。

## 接上前端

打開 `jiaminglake.js`，找到最上面的：

```js
var CLOUD_API_BASE = 'https://jiaminglake-api.YOUR-SUBDOMAIN.workers.dev';
```

把網址換成步驟 5 拿到的那個，然後把 `jiaminglake.js`（連同其他檔案）
一起 commit、push 到 GitHub。之後在 GitHub Pages 上使用「新增照片」等功能，
就會改由這支 Worker 直接把檔案寫回你的 repo。

## 之後要怎麼確認有沒有正常運作

1. 打開你的 GitHub Pages 網址（不是 localhost:8000）
2. 點開任一地標，按左上角 ➕ 上傳一張照片
3. 上傳成功訊息出現、頁面重新整理後，去你的 GitHub repo 看：
   - `photos/` 資料夾應該多一個新檔案
   - 最新的 commit 應該是這支 Worker 推的（commit message 會類似「新增地標照片: xxx」）
   - GitHub Pages 通常 30 秒 ～ 1 分鐘內就會重新部署完成，重新整理網頁就看得到新照片

如果失敗，先看瀏覽器開發者工具的 Console/Network，錯誤訊息會是 Worker 回傳的
`error` 欄位內容（例如 token 權限不夠、repo 名稱打錯等）。

## 疑難排解

**出現 `讀取 waypoint.json 失敗: HTTP 401`（或類似 401 訊息）**

幾乎都是 `GITHUB_TOKEN` 這個 secret 沒設好，常見原因：

- 根本忘了執行 `wrangler secret put GITHUB_TOKEN`，或執行時貼錯/貼到空白
- Token 貼到了 wrangler.toml 裡（那裡只能放 `[vars]` 明文變數，token 一定要用
  `wrangler secret put` 設定，否則會被打包進程式碼且不會生效）
- Token 已過期或被撤銷

排查步驟：

```bash
# 確認有沒有設定過這個 secret（只會顯示名稱，不會顯示內容）
wrangler secret list

# 不管有沒有列出來，重新設一次最保險（貼上時注意不要多貼到空白或換行）
wrangler secret put GITHUB_TOKEN

# 設完一定要重新部署一次
wrangler deploy
```

也可以到 GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens 確認這組 token 還在、沒過期、Repository access 有包含這個 repo，
且 Contents 權限是 **Read and write**。

**出現 `HTTP 404`**

通常是 `wrangler.toml` 裡的 `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` 打錯字，
或 token 沒有這個 repo 的存取權限。改完 `wrangler.toml` 記得要 `wrangler deploy` 才會生效。

**出現 `Worker 尚未設定完整: ...`**

Worker 會先檢查 `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`
是否都有值，缺哪個就會直接列出來，照訊息補上對應的 secret 或 `[vars]` 設定即可。
