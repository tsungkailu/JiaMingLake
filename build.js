/**
 * build.js — 將 waypoint.json 轉換成 waypoint-data.js
 *
 * 功能：
 *   1. 讀取 waypoint.json 的地標、GPS軌跡、高度剖面資料
 *   2. 對相鄰標記點之間判斷是否有 GPS 覆蓋
 *      - 有 GPS → 不補線（由 SEGMENTS 畫出）
 *      - 無 GPS → 自動補一條虛線連接兩點
 *   3. 處理支線（spur: true）：畫虛線去程＋回程
 *   4. 輸出 waypoint-data.js 供瀏覽器直接載入
 *
 * 使用方式：
 *   node build.js
 */

const fs   = require('fs');
const path = require('path');

// ── 設定 ──────────────────────────────────────────────────────────────
const GPS_THRESHOLD_M = 400;   // 中點距最近 GPS 座標 < 此值 → 視為有 GPS 覆蓋
const DAY_ORDER = ['D0','D1','D2','D3','D4'];

// ── 讀檔 ──────────────────────────────────────────────────────────────
const jsonPath = path.join(__dirname, 'waypoint.json');
const gpsPath  = path.join(__dirname, 'gps-segments.json');
const profilePath = path.join(__dirname, 'profile-data.json');
if(!fs.existsSync(jsonPath) || !fs.existsSync(gpsPath) || !fs.existsSync(profilePath)){
  console.error('❌ 找不到 waypoint.json、gps-segments.json 或 profile-data.json');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
const gpsSegments = JSON.parse(fs.readFileSync(gpsPath, 'utf-8'));
const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
data.gpsSegments = gpsSegments;
data.profileData = profileData;

const { waypoints, meta } = data;

if(!gpsSegments || !profileData){
  console.error('❌ 資料中缺少 gpsSegments 或 profileData 欄位');
  process.exit(1);
}

// ── 工具函式 ──────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const dlat = toRad(lat2 - lat1);
  const dlng = toRad(lng2 - lng1);
  const a = Math.sin(dlat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function toRad(deg){ return deg * Math.PI / 180; }

// 預先收集所有 GPS 座標點（加速查詢）
const allGpsCoords = gpsSegments.flatMap(s => s.c);

function nearestGpsDist(lat, lng){
  let min = Infinity;
  for(const [glat, glng] of allGpsCoords){
    const d = haversine(lat, lng, glat, glng);
    if(d < min) min = d;
    if(min < 1) break; // 夠近就提早結束
  }
  return min;
}

function midpoint(wpA, wpB){
  return {
    lat: (wpA.lat + wpB.lat) / 2,
    lng: (wpA.lng + wpB.lng) / 2
  };
}

function segmentHasGps(wpA, wpB){
  const mid = midpoint(wpA, wpB);
  const dist = nearestGpsDist(mid.lat, mid.lng);
  return dist < GPS_THRESHOLD_M;
}

// ── 建立有序標記點清單（跨天連接） ────────────────────────────────────
// 先依 day + order 排序
const sortedWps = [...waypoints].sort((a, b) => {
  const di = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
  return di !== 0 ? di : (a.order || 0) - (b.order || 0);
});

// ── 計算需要補線的路段 ────────────────────────────────────────────────
// 規則：
//   - 一般相鄰點：若無 GPS → 補實線（同色）
//   - spur 點（spurReturn: true）：
//       前一個非 spur 點 → spur 點：虛線去程
//       spur 點 → 前一個非 spur 點：虛線回程（自動加）
//       spur 點之後繼續接下一個非 spur 點，不重複計算

const supplementLines = [];  // { coords: [[lat,lng],...], day, dashed, label }

function addLine(wpA, wpB, dashed, label=''){
  supplementLines.push({
    coords: [[wpA.lat, wpA.lng], [wpB.lat, wpB.lng]],
    day: wpA.day,
    dashed,
    label
  });
}

let i = 0;
while(i < sortedWps.length - 1){
  const cur  = sortedWps[i];
  const next = sortedWps[i + 1];

  // Case 1: next 是 spur 端點
  if(next.spur && next.spurReturn){
    // 找回程點：cur（出發點）
    const origin = cur;
    // 去程：cur → next（虛線）
    addLine(origin, next, true, `${next.name} 支線（去程）`);
    console.log(`  [補線-虛線去程] ${origin.name} → ${next.name}`);
    // 回程：next → cur（虛線）
    supplementLines.push({
      coords: [[next.lat, next.lng], [origin.lat, origin.lng]],
      day: next.day,
      dashed: true,
      label: `${next.name} 支線（回程）`
    });
    console.log(`  [補線-虛線回程] ${next.name} → ${origin.name}`);
    // spur 點不影響主線序列，繼續從 i+2 開始
    i += 2;
    continue;
  }

  // Case 2: 一般相鄰（含跨天）
  if(cur.connectToNext){
    addLine(cur, next, false, `${cur.name} → ${next.name}`);
    console.log(`  [補線-實線] ${cur.name} → ${next.name}`);
  }

  i++;
}

// ── 輸出 waypoint-data.js ─────────────────────────────────────────────
const output = data;
output.supplementLines = supplementLines;

const jsContent =
  '// waypoint-data.js — 由 build.js 自動產生，請勿直接編輯\n' +
  '// 若要新增或修改地標，請編輯 waypoint.json 後執行：node build.js\n' +
  'var WAYPOINT_DATA = ' + JSON.stringify(output, null, 2) + ';\n';

const jsPath = path.join(__dirname, 'waypoint-data.js');
fs.writeFileSync(jsPath, jsContent, 'utf-8');

console.log('');
console.log(`✅ waypoint-data.js 已更新`);
console.log(`   地標數：${waypoints.length}`);
console.log(`   GPS 路段數：${gpsSegments.length}`);
console.log(`   補線數：${supplementLines.length}`);
