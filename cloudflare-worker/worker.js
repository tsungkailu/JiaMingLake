// =====================================================================
// cloudflare-worker/worker.js
// 讓 GitHub Pages（純靜態，無法執行任何後端程式）也能「上傳照片」的公開 API。
// 這支 Worker 收到請求後，改用 GitHub 的 Git Data API 把照片與資料直接寫回
// GitHub repo（等同於本機 server.js 寫本機硬碟的行為，只是改寫進 repo）。
//
// 寫入策略：photo 檔案 + waypoint.json + waypoint-data.js 一律打包成「同一個 git
// commit」寫入（build tree → create commit → 更新 branch ref），確保兩份資料檔
// 永遠同步、不會發生只成功一半的情況。若 ref 更新時發現分支已經被別的請求推進
// （代表兩個請求幾乎同時寫入），就整個重新讀最新狀態、重新套用這次修改再 commit
// 一次，直到成功或超過重試次數 —— 這樣連續上傳、或多人同時上傳都不會互相蓋掉。
//
// 部署方式請見同資料夾的 README.md。
// =====================================================================

const GITHUB_API = 'https://api.github.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 帶有 HTTP 狀態碼的錯誤，讓呼叫端能判斷是不是「版本衝突」而值得重試
class GithubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------
// GitHub API 基礎工具
// ---------------------------------------------------------------------
function ghHeaders(env) {
  return {
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'User-Agent': 'jiaminglake-worker',
    'Accept': 'application/vnd.github+json'
  };
}

// 依 HTTP 狀態碼組出好懂一點的錯誤訊息 (401/403 幾乎都是 token 沒設好或權限不夠)
async function describeGithubError(res) {
  const bodyText = await res.text();
  if (res.status === 401) {
    return 'HTTP 401（GITHUB_TOKEN 無效或未設定，請確認有用 wrangler secret put GITHUB_TOKEN 設定過，且 token 沒有過期/被撤銷）: ' + bodyText;
  }
  if (res.status === 403) {
    return 'HTTP 403（token 權限不夠，請確認 fine-grained token 有勾選這個 repo 且 Contents 權限為 Read and write）: ' + bodyText;
  }
  if (res.status === 404) {
    return 'HTTP 404（請確認 wrangler.toml 裡的 GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH 是否正確，以及 token 是否有這個 repo 的存取權）: ' + bodyText;
  }
  return 'HTTP ' + res.status + ': ' + bodyText;
}

async function ghApi(env, method, path, body) {
  const res = await fetch(GITHUB_API + path, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(env)),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw new GithubApiError(method + ' ' + path + ' 失敗: ' + (await describeGithubError(res)), res.status);
  }
  return res.json();
}

function repoContentsPath(env, path) {
  return '/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/contents/' + path;
}
function repoGitPath(env, sub) {
  return '/repos/' + env.GITHUB_OWNER + '/' + env.GITHUB_REPO + '/git/' + sub;
}

// 目前分支頂端的 commit SHA
async function ghGetHeadCommitSha(env) {
  const ref = await ghApi(env, 'GET', repoGitPath(env, 'ref/heads/' + env.GITHUB_BRANCH));
  return ref.object.sha;
}

// 讀取檔案文字內容。
// ref 一定要傳「commit SHA」而不是分支名稱：用分支名稱讀時 GitHub 會走 CDN 快取，
// 剛寫入後短時間內可能讀到舊內容，導致同一次請求裡兩個檔案讀到不同版本，
// 把「一份新、一份舊」的不一致狀態寫回 repo。commit SHA 指向的內容不可變，沒有這個問題。
async function ghGetTextFile(env, path, ref) {
  const json = await ghApi(env, 'GET', repoContentsPath(env, path) + '?ref=' + ref);
  return base64ToUtf8(json.content);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------
// Git Data API：把多個檔案變更打包成同一個 commit 一次寫入 (原子操作)
// ---------------------------------------------------------------------

// fileChanges: [{ path, content }]                → 建立/覆蓋文字檔 (UTF-8)
//              [{ path, content, isBase64: true }] → 建立/覆蓋二進位檔 (base64)
//              [{ path, delete: true }]            → 刪除檔案
// baseCommitSha 必須是「這次修改所根據的那份內容」的 commit，
// 讀檔與 commit 的 parent 都用它，才能保證改動是疊在自己真正讀到的版本上。
async function commitFilesOnce(env, message, fileChanges, baseCommitSha) {
  const headCommit = await ghApi(env, 'GET', repoGitPath(env, 'commits/' + baseCommitSha));
  const baseTreeSha = headCommit.tree.sha;

  const treeEntries = [];
  for (const change of fileChanges) {
    if (change.delete) {
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
    } else if (change.isBase64) {
      const blob = await ghApi(env, 'POST', repoGitPath(env, 'blobs'), {
        content: change.content,
        encoding: 'base64'
      });
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', content: change.content });
    }
  }

  const newTree = await ghApi(env, 'POST', repoGitPath(env, 'trees'), {
    base_tree: baseTreeSha,
    tree: treeEntries
  });

  const newCommit = await ghApi(env, 'POST', repoGitPath(env, 'commits'), {
    message: message,
    tree: newTree.sha,
    parents: [baseCommitSha]
  });

  // force:false → 若分支在這期間被別的請求推進 (非 fast-forward)，這裡會失敗，
  // 代表發生版本衝突，呼叫端要重新讀最新狀態、重新套用修改後再 commit 一次。
  await ghApi(env, 'PATCH', repoGitPath(env, 'refs/heads/' + env.GITHUB_BRANCH), {
    sha: newCommit.sha,
    force: false
  });
}

// waypoint.json / waypoint-data.js 讀寫
// waypoint-data.js 是 "var WAYPOINT_DATA = {...};" 這種格式，
// 直接沿用 build.js 產生時的檔頭註解，只把中間的 JSON 換掉。
const WAYPOINT_DATA_HEADER =
  '// waypoint-data.js — 由 build.js 自動產生，請勿直接編輯\n' +
  '// 若要新增或修改地標，請編輯 waypoint.json 後執行：node build.js\n';

function parseWaypointDataJs(text) {
  const m = text.match(/var WAYPOINT_DATA\s*=\s*([\s\S]*);\s*$/);
  if (!m) throw new Error('無法解析 waypoint-data.js 格式');
  return JSON.parse(m[1]);
}

function serializeWaypointDataJs(obj) {
  return WAYPOINT_DATA_HEADER + 'var WAYPOINT_DATA = ' + JSON.stringify(obj, null, 2) + ';\n';
}

function findWaypoint(waypoints, order, name) {
  if (order !== undefined && order !== null && order !== '') {
    const found = waypoints.find(function (w) { return w.order === parseInt(order); });
    if (found) return found;
  }
  return waypoints.find(function (w) { return w.name === name; });
}

// 同時在 waypoint.json 與 waypoint-data.js 兩份資料裡找到「同一個地標」，
// 讓 mutator 可以一次把改動套用在兩邊，保持兩份資料結構一致。
function findWaypointPair(files, order, name) {
  const wpJson = findWaypoint(files.json.waypoints, order, name);
  const wpData = findWaypoint(files.data.waypoints, order, name);
  if (!wpJson || !wpData) return null;
  return { json: wpJson, data: wpData };
}

// 兩個檔案都固定從同一個 commit 讀，確保拿到的是同一個版本的內容
async function loadWaypointFiles(env, ref) {
  const jsonText = await ghGetTextFile(env, 'waypoint.json', ref);
  const dataText = await ghGetTextFile(env, 'waypoint-data.js', ref);
  return {
    json: JSON.parse(jsonText),
    data: parseWaypointDataJs(dataText)
  };
}

// 核心流程（一次完整的 compare-and-swap）：
//   1. 取得分支目前的 commit SHA
//   2. 固定用這個 SHA 讀 waypoint.json / waypoint-data.js（不用分支名稱，避開 CDN 快取）
//   3. 套用 mutator
//   4. 連同 extraFileChanges（例如照片檔案）打包成同一個 commit，parent 就是步驟 1 的 SHA
//   5. 更新分支時要求 fast-forward；若這期間有別的請求先 commit 了就會失敗，整個從步驟 1 重來
// 這樣「讀到的版本」與「疊上去的版本」保證是同一個，不會有只寫一半或兩個檔案版本不一致的情況。
// mutator 回傳 falsy 代表「找不到要改的地標/照片」，此時不會有任何寫入動作。
//
// extraFileChanges 可以是固定的陣列，也可以是一個函式 (mutationResult) => 陣列——
// 有些操作 (例如換圖) 要等 mutator 找到照片、知道它實際的檔案路徑後，才能決定要寫哪個檔案，
// 用函式就能在每次重試時都拿到那次讀到的最新內容算出來的路徑，不會用到過期的路徑。
async function commitWaypointMutation(env, mutator, message, extraFileChanges, maxAttempts) {
  maxAttempts = maxAttempts || 5;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const baseCommitSha = await ghGetHeadCommitSha(env);
    const files = await loadWaypointFiles(env, baseCommitSha);
    const result = mutator(files);
    if (!result) return null;

    const extras = typeof extraFileChanges === 'function' ? extraFileChanges(result) : (extraFileChanges || []);
    const fileChanges = extras.concat([
      { path: 'waypoint.json', content: JSON.stringify(files.json, null, 2) },
      { path: 'waypoint-data.js', content: serializeWaypointDataJs(files.data) }
    ]);

    try {
      await commitFilesOnce(env, message, fileChanges, baseCommitSha);
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof GithubApiError && (err.status === 409 || err.status === 422);
      if (!retryable || attempt === maxAttempts) throw err;
      await sleep(250 * attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------
// Google Drive 單一檔案下載 (與本機 server.js 邏輯相同，改用 fetch 實作)
// ---------------------------------------------------------------------
function extractDriveFileId(url) {
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(url.trim())) return url.trim();
  return null;
}

async function downloadFromDrive(url, redirectsLeft) {
  if (redirectsLeft < 0) throw new Error('重新導向次數過多');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下載失敗，HTTP 狀態碼: ' + res.status);

  const contentType = res.headers.get('content-type') || '';
  if (contentType.indexOf('image/') === 0) {
    // 直接把 res 原封不動地串流回去，不要整包讀進記憶體再手動轉 base64
    // (大檔案手動 base64 編碼是很吃 CPU 的迴圈，容易撞到 Workers 的 CPU 時間上限而被中止)
    return { contentType: contentType.split(';')[0], response: res };
  }

  if (contentType.indexOf('text/html') === 0 && redirectsLeft > 0) {
    const html = await res.text();
    const confirmMatch = html.match(/confirm=([0-9A-Za-z_]+)/);
    const idMatch = html.match(/name="id" value="([^"]+)"/);
    if (confirmMatch) {
      const fileId = idMatch ? idMatch[1] : null;
      const retryUrl = fileId
        ? 'https://drive.google.com/uc?export=download&confirm=' + confirmMatch[1] + '&id=' + fileId
        : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'confirm=' + confirmMatch[1];
      return downloadFromDrive(retryUrl, redirectsLeft - 1);
    }
  }

  throw new Error('無法從連結取得圖片，請確認該檔案已設定為「知道連結的使用者」可檢視');
}

// ---------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------
async function handleUpload(env, payload) {
  const { waypointName, waypointOrder, title, body, image, ext } = payload;
  if ((!waypointName && waypointOrder === undefined) || !image) {
    return jsonResponse({ success: false, error: '缺少地標資訊或圖片資料' }, 400);
  }

  // 前端 canvas 若不支援輸出 webp 會自動退回 png，副檔名要跟著實際內容走，避免存成內容與副檔名不符的檔案
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext || '') ? ext : 'webp';
  const cleanName = waypointName.replace(/[^一-龥a-zA-Z0-9_-]/g, '');
  const filename = cleanName + '_' + Date.now() + '.' + safeExt;
  const filePath = 'photos/' + filename;
  // 手機瀏覽器若不支援 canvas 輸出 webp，會自動退回輸出 png，
  // 前綴不再是 data:image/webp;base64,，所以這裡改成通用比對，不寫死格式。
  const base64Data = image.replace(/^data:[^;]*;base64,/, '');

  // 每張照片都要有一個跟路徑無關的唯一 id：佔位圖等多張照片可能共用同一個
  // 檔案路徑，如果編輯/刪除是用路徑去找，會抓到路徑相同的第一張、改錯照片。
  const photoId = crypto.randomUUID();

  const result = await commitWaypointMutation(env, function (files) {
    const pair = findWaypointPair(files, waypointOrder, waypointName);
    if (!pair) return null;
    const entry = { src: filePath, title: title || '', body: body || '', id: photoId };
    if (!pair.json.photos) pair.json.photos = [];
    if (!pair.data.photos) pair.data.photos = [];
    pair.json.photos.push(entry);
    pair.data.photos.push(Object.assign({}, entry));
    return pair;
  }, '新增地標照片: ' + waypointName, [
    { path: filePath, content: base64Data, isBase64: true }
  ]);

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標' }, 404);
  return jsonResponse({ success: true, src: filePath, id: photoId });
}

async function handleUpdatePhoto(env, payload) {
  const { waypointName, waypointOrder, photoId, title, body, image, ext } = payload;
  if ((!waypointName && waypointOrder === undefined) || !photoId) {
    return jsonResponse({ success: false, error: '缺少地標資訊或照片 id' }, 400);
  }
  const base64Data = image ? image.replace(/^data:[^;]*;base64,/, '') : null;
  // 前端 canvas 若不支援輸出 webp 會自動退回 png，副檔名要跟著實際內容走，避免存成內容與副檔名不符的檔案
  const safeExt = /^[a-z0-9]{1,5}$/.test(ext || '') ? ext : 'webp';

  const result = await commitWaypointMutation(env, function (files) {
    const pair = findWaypointPair(files, waypointOrder, waypointName);
    if (!pair || !pair.json.photos || !pair.data.photos) return null;
    const photoJson = pair.json.photos.find(function (p) { return p.id === photoId; });
    const photoData = pair.data.photos.find(function (p) { return p.id === photoId; });
    if (!photoJson || !photoData) return null;

    if (title !== undefined) { photoJson.title = title; photoData.title = title; }
    if (body !== undefined) { photoJson.body = body; photoData.body = body; }

    // 換圖的路徑：如果這張照片目前的路徑是跟別人共用的 (例如還沒換掉的佔位圖)，
    // 不能直接覆蓋原檔——那會連帶把其他還在用同一張圖的照片也換成這張新圖。
    // 這種情況要另外開一個新檔案，只有這張照片自己在用時才可以直接覆蓋原檔。
    let newImagePath = null;
    if (base64Data) {
      const sharedWithOthers = files.json.waypoints.some(function (w) {
        return (w.photos || []).some(function (p) { return p !== photoJson && p.src === photoJson.src; });
      });
      newImagePath = sharedWithOthers
        ? 'photos/' + (waypointName || 'photo').replace(/[^一-龥a-zA-Z0-9_-]/g, '') + '_' + Date.now() + '.' + safeExt
        : photoJson.src;
      photoJson.src = newImagePath;
      photoData.src = newImagePath;
    }

    return { photoJson: photoJson, imagePath: newImagePath };
  }, '編輯照片: id=' + photoId, function (mutationResult) {
    return mutationResult.imagePath
      ? [{ path: mutationResult.imagePath, content: base64Data, isBase64: true }]
      : [];
  });

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標或照片' }, 404);
  return jsonResponse({ success: true, src: result.imagePath || undefined });
}

async function handleDeletePhoto(env, payload) {
  const { waypointName, waypointOrder, photoId } = payload;
  if ((!waypointName && waypointOrder === undefined) || !photoId) {
    return jsonResponse({ success: false, error: '缺少地標資訊或照片 id' }, 400);
  }

  const result = await commitWaypointMutation(env, function (files) {
    const pair = findWaypointPair(files, waypointOrder, waypointName);
    if (!pair || !pair.json.photos || !pair.data.photos) return null;
    const idxJson = pair.json.photos.findIndex(function (p) { return p.id === photoId; });
    const idxData = pair.data.photos.findIndex(function (p) { return p.id === photoId; });
    if (idxJson < 0 || idxData < 0) return null;

    const deletedSrc = pair.json.photos[idxJson].src;
    pair.json.photos.splice(idxJson, 1);
    pair.data.photos.splice(idxData, 1);

    // 檔案路徑可能被其他照片共用 (例如都還沒換掉的佔位圖)，只有確定刪除這筆記錄後
    // 已經沒有其他照片還在用同一個路徑，才把檔案從 repo 一併刪掉，
    // 避免誤刪還在用的圖，同一個 commit 判斷才不會有版本不一致的問題。
    const stillUsed = files.json.waypoints.some(function (w) {
      return (w.photos || []).some(function (p) { return p.src === deletedSrc; });
    });
    return { deletedSrc: stillUsed ? null : deletedSrc };
  }, '刪除照片: id=' + photoId, function (mutationResult) {
    return mutationResult.deletedSrc ? [{ path: mutationResult.deletedSrc, delete: true }] : [];
  });

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標或照片' }, 404);
  return jsonResponse({ success: true });
}

async function handleReorderPhoto(env, payload) {
  const { waypointName, waypointOrder, photoId, direction } = payload;
  if ((!waypointName && waypointOrder === undefined) || !photoId) {
    return jsonResponse({ success: false, error: '缺少地標資訊或照片 id' }, 400);
  }
  if (direction !== 'prev' && direction !== 'next') {
    return jsonResponse({ success: false, error: 'direction 必須是 prev 或 next' }, 400);
  }

  const result = await commitWaypointMutation(env, function (files) {
    const pair = findWaypointPair(files, waypointOrder, waypointName);
    if (!pair || !pair.json.photos || !pair.data.photos) return null;
    const idxJson = pair.json.photos.findIndex(function (p) { return p.id === photoId; });
    const idxData = pair.data.photos.findIndex(function (p) { return p.id === photoId; });
    if (idxJson < 0 || idxData < 0) return null;

    const swapWith = idxJson + (direction === 'prev' ? -1 : 1);
    // 已經是第一張／最後一張就不能再往那個方向移，回傳 null 讓外層當成「找不到」處理
    if (swapWith < 0 || swapWith >= pair.json.photos.length) return null;

    const tmpJson = pair.json.photos[idxJson];
    pair.json.photos[idxJson] = pair.json.photos[swapWith];
    pair.json.photos[swapWith] = tmpJson;
    const tmpData = pair.data.photos[idxData];
    pair.data.photos[idxData] = pair.data.photos[swapWith];
    pair.data.photos[swapWith] = tmpData;

    return pair;
  }, '調整照片順序: id=' + photoId + ' ' + direction);

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標／照片，或已經是最前／最後一張' }, 404);
  return jsonResponse({ success: true });
}

async function handleUpdateWaypoint(env, payload) {
  const { waypointOrder, name, day, time, km, elevation, desc } = payload;
  if (waypointOrder === undefined) {
    return jsonResponse({ success: false, error: '缺少地標編號' }, 400);
  }

  const result = await commitWaypointMutation(env, function (files) {
    const wpJson = files.json.waypoints.find(function (w) { return w.order === parseInt(waypointOrder); });
    const wpData = files.data.waypoints.find(function (w) { return w.order === parseInt(waypointOrder); });
    if (!wpJson || !wpData) return null;
    [wpJson, wpData].forEach(function (wp) {
      if (name) { wp.name = name; wp.title = name; }
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
    });
    return wpJson;
  }, '更新地標資料: order=' + waypointOrder);

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標' }, 404);
  return jsonResponse({ success: true });
}

async function handleUpdateCoords(env, payload) {
  const { waypointName, waypointOrder, lat, lng } = payload;
  if ((!waypointName && waypointOrder === undefined) || lat === undefined || lng === undefined) {
    return jsonResponse({ success: false, error: '缺少地標資訊或座標資料' }, 400);
  }

  const result = await commitWaypointMutation(env, function (files) {
    const pair = findWaypointPair(files, waypointOrder, waypointName);
    if (!pair) return null;
    pair.json.lat = parseFloat(lat);
    pair.json.lng = parseFloat(lng);
    pair.data.lat = parseFloat(lat);
    pair.data.lng = parseFloat(lng);
    return pair;
  }, '更新座標: ' + (waypointName || waypointOrder));

  if (!result) return jsonResponse({ success: false, error: '找不到對應的地標' }, 404);
  return jsonResponse({ success: true });
}

async function handleFetchDriveImage(payload) {
  const rawUrl = (payload.url || '').trim();
  if (!rawUrl) return jsonResponse({ success: false, error: '請提供 Google Drive 分享連結' }, 400);

  const fileId = extractDriveFileId(rawUrl);
  if (!fileId) return jsonResponse({ success: false, error: '無法從連結解析出檔案 ID，請確認是單一檔案的分享連結' }, 400);

  const downloadUrl = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
  const result = await downloadFromDrive(downloadUrl, 5);
  // 直接把圖片位元組串流回瀏覽器 (Content-Type 設成原始圖片格式)，
  // 讓瀏覽器自己用 FileReader 轉成 data URL，跟本機選檔案上傳走同一套流程。
  return new Response(result.response.body, {
    status: 200,
    headers: Object.assign({ 'Content-Type': result.contentType }, CORS_HEADERS)
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ success: false, error: '僅支援 POST' }, 405);
    }

    const missingEnv = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH']
      .filter(function (key) { return !env[key]; });
    if (missingEnv.length) {
      return jsonResponse({
        success: false,
        error: 'Worker 尚未設定完整: ' + missingEnv.join(', ') +
          '（GITHUB_TOKEN 請用 wrangler secret put 設定；其餘請在 wrangler.toml 的 [vars] 填好後重新 wrangler deploy）'
      }, 500);
    }

    const url = new URL(request.url);
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: '請求格式錯誤，需為 JSON' }, 400);
    }

    try {
      switch (url.pathname) {
        case '/api/upload':
          return await handleUpload(env, payload);
        case '/api/update-photo':
          return await handleUpdatePhoto(env, payload);
        case '/api/delete-photo':
          return await handleDeletePhoto(env, payload);
        case '/api/reorder-photo':
          return await handleReorderPhoto(env, payload);
        case '/api/update-waypoint':
          return await handleUpdateWaypoint(env, payload);
        case '/api/update-coords':
          return await handleUpdateCoords(env, payload);
        case '/api/fetch-drive-image':
          return await handleFetchDriveImage(payload);
        default:
          return jsonResponse({ success: false, error: '找不到此 API 路徑' }, 404);
      }
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }
};
