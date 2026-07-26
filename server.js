const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 8000;
const PUBLIC_DIR = __dirname;
const PHOTOS_DIR = path.join(PUBLIC_DIR, 'photos');

// 確保 photos 資料夾存在
if (!fs.existsSync(PHOTOS_DIR)) {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// 從各種 Google Drive 分享連結格式中解析出檔案 ID
function extractDriveFileId(url) {
  var m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim();
  return null;
}

// 下載 Google Drive 公開檔案 (不需要 API 金鑰)，並自動處理重新導向與
// 「檔案過大，Google 無法掃描病毒」的確認頁面
function downloadFromDrive(url, cookies, redirectsLeft, callback) {
  if (redirectsLeft < 0) {
    callback(new Error('重新導向次數過多'));
    return;
  }
  var headers = {};
  if (cookies.length) headers['Cookie'] = cookies.join('; ');

  https.get(url, { headers: headers }, function (res) {
    var newCookies = cookies;
    if (res.headers['set-cookie']) {
      newCookies = cookies.concat(res.headers['set-cookie'].map(function (c) { return c.split(';')[0]; }));
    }

    if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
      res.resume();
      var nextUrl = new URL(res.headers.location, url).toString();
      downloadFromDrive(nextUrl, newCookies, redirectsLeft - 1, callback);
      return;
    }

    if (res.statusCode !== 200) {
      res.resume();
      callback(new Error('下載失敗，HTTP 狀態碼: ' + res.statusCode));
      return;
    }

    var contentType = res.headers['content-type'] || '';
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var buffer = Buffer.concat(chunks);

      if (contentType.indexOf('image/') === 0) {
        callback(null, { contentType: contentType.split(';')[0], buffer: buffer });
        return;
      }

      // 檔案較大時 Google 會回傳一個確認頁面，嘗試解析 confirm token 後重試一次
      if (contentType.indexOf('text/html') === 0 && redirectsLeft > 0) {
        var html = buffer.toString('utf-8');
        var confirmMatch = html.match(/confirm=([0-9A-Za-z_]+)/);
        var idMatch = html.match(/name="id" value="([^"]+)"/);
        if (confirmMatch) {
          var fileId = idMatch ? idMatch[1] : null;
          var retryUrl = fileId
            ? 'https://drive.google.com/uc?export=download&confirm=' + confirmMatch[1] + '&id=' + fileId
            : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'confirm=' + confirmMatch[1];
          downloadFromDrive(retryUrl, newCookies, redirectsLeft - 1, callback);
          return;
        }
      }

      callback(new Error('無法從連結取得圖片，請確認該檔案已設定為「知道連結的使用者」可檢視'));
    });
  }).on('error', function (err) { callback(err); });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // 允許跨來源資源共用 (CORS) 相關 Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 處理 CORS Preflight (OPTIONS) 請求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 處理從 Google Drive 分享連結下載圖片的 API (不需要 API 金鑰，僅支援單一公開檔案連結)
  if (req.method === 'POST' && req.url === '/api/fetch-drive-image') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const rawUrl = (payload.url || '').trim();

        if (!rawUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '請提供 Google Drive 分享連結' }));
          return;
        }

        const fileId = extractDriveFileId(rawUrl);
        if (!fileId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '無法從連結解析出檔案 ID，請確認是單一檔案的分享連結' }));
          return;
        }

        const downloadUrl = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
        downloadFromDrive(downloadUrl, [], 5, (err, result) => {
          if (err) {
            console.error('[Server] 雲端硬碟下載錯誤:', err);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
          }
          const base64 = result.buffer.toString('base64');
          console.log(`[Server] 已從 Google Drive 下載圖片: id=${fileId}, ${result.buffer.length} bytes`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, dataUrl: `data:${result.contentType};base64,${base64}` }));
        });
      } catch (err) {
        console.error('[Server] 雲端硬碟下載錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理照片上傳的 API
  if (req.method === 'POST' && req.url === '/api/upload') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { waypointName, waypointOrder, title, body: desc, image } = payload;

        if ((!waypointName && waypointOrder === undefined) || !image) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '缺少地標資訊或圖片資料' }));
          return;
        }

        // 清理檔名，只保留中英文字元、數字與底線
        const cleanName = waypointName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '');
        const filename = `${cleanName}_${Date.now()}.webp`;
        const filePath = path.join(PHOTOS_DIR, filename);

        // 解密 base64 WebP 圖片資料並存檔
        const base64Data = image.replace(/^data:image\/webp;base64,/, "");
        fs.writeFileSync(filePath, base64Data, 'base64');
        console.log(`[Server] 已存檔: ${filePath}`);

        // 讀取並更新 waypoint.json
        const jsonPath = path.join(PUBLIC_DIR, 'waypoint.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到 waypoint.json 檔案' }));
          return;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const wp = (waypointOrder !== undefined)
          ? data.waypoints.find(w => w.order === parseInt(waypointOrder))
          : data.waypoints.find(w => w.name === waypointName);
        if (!wp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `找不到對應的地標` }));
          return;
        }

        if (!wp.photos) {
          wp.photos = [];
        }

        // 新增照片項目
        wp.photos.push({
          src: `photos/${filename}`,
          title: title || '',
          body: desc || ''
        });

        // 寫回 waypoint.json
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Server] waypoint.json 已更新: ${waypointName}`);

        // 自動執行 node build.js 重新編譯 waypoint-data.js
        console.log('[Server] 正在執行 node build.js...');
        execSync('node build.js', { cwd: PUBLIC_DIR });
        console.log('[Server] build.js 執行成功');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, src: `photos/${filename}` }));
      } catch (err) {
        console.error('[Server] 上傳錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理照片刪除的 API
  if (req.method === 'POST' && req.url === '/api/delete-photo') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { waypointName, waypointOrder, photoSrc } = payload;

        if ((!waypointName && waypointOrder === undefined) || !photoSrc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '缺少地標資訊或照片路徑' }));
          return;
        }

        // 讀取並更新 waypoint.json
        const jsonPath = path.join(PUBLIC_DIR, 'waypoint.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到 waypoint.json 檔案' }));
          return;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const wp = (waypointOrder !== undefined)
          ? data.waypoints.find(w => w.order === parseInt(waypointOrder))
          : data.waypoints.find(w => w.name === waypointName);
        if (!wp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `找不到對應的地標` }));
          return;
        }

        if (wp.photos) {
          const idx = wp.photos.findIndex(p => p.src === photoSrc);
          if (idx >= 0) {
            wp.photos.splice(idx, 1);
          }
        }

        // 寫回 waypoint.json
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Server] waypoint.json 已刪除項目: ${waypointName} -> ${photoSrc}`);

        // 刪除實體檔案 (只允許刪除 photos/ 開頭的本機上傳檔案)
        if (photoSrc.startsWith('photos/')) {
          const baseFilename = path.basename(photoSrc);
          const fullFilePath = path.join(PHOTOS_DIR, baseFilename);
          
          if (fs.existsSync(fullFilePath)) {
            fs.unlinkSync(fullFilePath);
            console.log(`[Server] 已刪除實體檔案: ${fullFilePath}`);
          }
        }

        // 自動執行 node build.js 重新編譯
        console.log('[Server] 正在執行 node build.js...');
        execSync('node build.js', { cwd: PUBLIC_DIR });
        console.log('[Server] build.js 執行成功');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('[Server] 刪除錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理更新標記點座標的 API
  if (req.method === 'POST' && req.url === '/api/update-coords') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { waypointName, waypointOrder, lat, lng } = payload;

        if ((!waypointName && waypointOrder === undefined) || lat === undefined || lng === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '缺少地標資訊或座標資料' }));
          return;
        }

        // 讀取並更新 waypoint.json
        const jsonPath = path.join(PUBLIC_DIR, 'waypoint.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到 waypoint.json 檔案' }));
          return;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const wp = (waypointOrder !== undefined)
          ? data.waypoints.find(w => w.order === parseInt(waypointOrder))
          : data.waypoints.find(w => w.name === waypointName);
        if (!wp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `找不到對應的地標` }));
          return;
        }

        // 更新座標為浮點數
        wp.lat = parseFloat(lat);
        wp.lng = parseFloat(lng);

        // 寫回 waypoint.json
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Server] 已更新座標: ${waypointName} -> [${wp.lat}, ${wp.lng}]`);

        // 自動執行 node build.js 重新編譯
        console.log('[Server] 正在執行 node build.js...');
        execSync('node build.js', { cwd: PUBLIC_DIR });
        console.log('[Server] build.js 執行成功');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('[Server] 更新座標錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理更新地標基本資料的 API
  if (req.method === 'POST' && req.url === '/api/update-waypoint') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { waypointOrder, name, day, time, km, elevation, desc } = payload;

        if (waypointOrder === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '缺少地標編號' }));
          return;
        }

        // 讀取並更新 waypoint.json
        const jsonPath = path.join(PUBLIC_DIR, 'waypoint.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到 waypoint.json 檔案' }));
          return;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const wp = data.waypoints.find(w => w.order === parseInt(waypointOrder));
        if (!wp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `找不到對應的地標` }));
          return;
        }

        if (name) {
          wp.name = name;
          wp.title = name;
        }
        if (day) wp.day = day;
        if (time) wp.time = time;
        if (km) {
          wp.km = km;
          const kmNum = parseFloat(km);
          if (!isNaN(kmNum)) wp.profile_km = kmNum;
        }
        if (elevation) {
          wp.elevation = elevation;
          const eleNum = parseFloat(elevation);
          if (!isNaN(eleNum)) wp.profile_ele = eleNum;
        }
        if (desc !== undefined) wp.desc = desc;

        // 寫回 waypoint.json
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Server] 已更新地標資料: order=${waypointOrder} -> ${wp.name}`);

        // 自動執行 node build.js 重新編譯
        console.log('[Server] 正在執行 node build.js...');
        execSync('node build.js', { cwd: PUBLIC_DIR });
        console.log('[Server] build.js 執行成功');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('[Server] 更新地標資料錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理編輯照片 (標題／文案／換圖) 的 API
  if (req.method === 'POST' && req.url === '/api/update-photo') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { waypointName, waypointOrder, photoSrc, title, body: desc, image } = payload;

        if ((!waypointName && waypointOrder === undefined) || !photoSrc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '缺少地標資訊或照片路徑' }));
          return;
        }

        // 讀取並更新 waypoint.json
        const jsonPath = path.join(PUBLIC_DIR, 'waypoint.json');
        if (!fs.existsSync(jsonPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到 waypoint.json 檔案' }));
          return;
        }

        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const wp = (waypointOrder !== undefined)
          ? data.waypoints.find(w => w.order === parseInt(waypointOrder))
          : data.waypoints.find(w => w.name === waypointName);
        if (!wp || !wp.photos) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到對應的地標或照片' }));
          return;
        }

        const photo = wp.photos.find(p => p.src === photoSrc);
        if (!photo) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: '找不到對應的照片' }));
          return;
        }

        if (title !== undefined) photo.title = title;
        if (desc !== undefined) photo.body = desc;

        // 若有提供新圖片，覆蓋原本的實體檔案 (檔名維持不變，只允許操作 photos/ 目錄內的檔案)
        if (image) {
          if (!photoSrc.startsWith('photos/')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '不合法的照片路徑' }));
            return;
          }
          const base64Data = image.replace(/^data:image\/webp;base64,/, "");
          const baseFilename = path.basename(photoSrc);
          const fullFilePath = path.join(PHOTOS_DIR, baseFilename);
          fs.writeFileSync(fullFilePath, base64Data, 'base64');
          console.log(`[Server] 已覆蓋照片檔案: ${fullFilePath}`);
        }

        // 寫回 waypoint.json
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Server] waypoint.json 照片資料已更新: ${photoSrc}`);

        // 自動執行 node build.js 重新編譯
        console.log('[Server] 正在執行 node build.js...');
        execSync('node build.js', { cwd: PUBLIC_DIR });
        console.log('[Server] build.js 執行成功');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('[Server] 更新照片錯誤:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 處理靜態檔案代理
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') {
    reqPath = '/jiaminglake.html';
  }

  const filePath = path.join(PUBLIC_DIR, reqPath);
  
  // 安全性防範：防止 directory traversal 漏洞
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[Server] 伺服器正在運行於 http://localhost:${PORT}/`);
});
