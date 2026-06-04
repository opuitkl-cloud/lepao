const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const CryptoJS = require('crypto-js');

const PORT = 6660;
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'whut_history.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

// ═══ 内存缓存 ═══
let settingsCache = null;
let settingsCacheTime = 0;
let historyCache = null;
let historyCacheTime = 0;
const staticCache = new Map();      // path -> { data, mime, mtime }
const STATIC_TTL = 60000;           // 静态文件缓存 1 分钟
const CACHE_TTL = 3000;             // settings/history 缓存 3 秒

// ══════════════════════════════════════════════════════════════
// WHUT API（嵌入版，不依赖外部文件）
// ══════════════════════════════════════════════════════════════

const WHUT_AES_KEY  = CryptoJS.enc.Utf8.parse('Wet2C8d34f62ndi3');
const WHUT_AES_IV   = CryptoJS.enc.Utf8.parse('K6iv85jBD8jgf32D');
const WHUT_AES_OPTS = { iv: WHUT_AES_IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 };
const SIGN_SECRET   = 'rDJiNB9j7vD2';
const API_BASE      = 'https://tzcs.whut.edu.cn/v3/api.php';
const OSS_BUCKET    = 'lptiyu-ps5';
const OSS_ENDPOINT  = `https://${OSS_BUCKET}.oss-cn-hangzhou.aliyuncs.com`;

const WHUT_CP = {
  // 南湖校区 (game_id=1)
  '14': { lat: 30.509007, lng: 114.329637, name: '体育场北' },
  '15': { lat: 30.507606, lng: 114.329621, name: '体育场南' },
  '16': { lat: 30.508397, lng: 114.328302, name: '学生公寓南二栋' },
  '17': { lat: 30.506941, lng: 114.327894, name: '南六宿舍楼' },
  '18': { lat: 30.505217, lng: 114.331129, name: '体育馆东门' },
  // 余家头校区 (game_id=2)
  '20': { lat: 30.606097, lng: 114.355591, name: '田径场南' },
  '21': { lat: 30.607585, lng: 114.355263, name: '田径场北' },
  '22': { lat: 30.606844, lng: 114.357265, name: '余区一舍' },
  '34': { lat: 30.606652, lng: 114.355189, name: '田径场西' },
  // 鉴湖校区 (game_id=3)
  '23': { lat: 30.514450, lng: 114.342177, name: '学海篮球场东' },
  '24': { lat: 30.515626, lng: 114.343264, name: '学海足球场北' },
  '25': { lat: 30.514705, lng: 114.343068, name: '学海足球场南' },
  // 马房山校区东院 (game_id=4)
  '30': { lat: 30.518726, lng: 114.353890, name: '东院图书馆' },
  '31': { lat: 30.518502, lng: 114.352045, name: '东院就业大楼' },
  '32': { lat: 30.516923, lng: 114.353911, name: '东院田径场北' },
  '33': { lat: 30.515768, lng: 114.353976, name: '东院田径场南' },
  // 马房山校区西院 (game_id=5)
  '26': { lat: 30.519471, lng: 114.346949, name: '田径场北' },
  '27': { lat: 30.520737, lng: 114.348032, name: '恬园食堂大门' },
  '28': { lat: 30.520793, lng: 114.349931, name: '光纤传感技术国家实验室' },
  '29': { lat: 30.517991, lng: 114.346912, name: '田径场南' },
};
const CP_HIT_RADIUS = 200;

const jobs = new Map();
let jobCounter = 0;

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, dL = (lat2 - lat1) * Math.PI / 180, dG = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dL / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function random6() { return String(Math.floor(100000 + Math.random() * 900000)); }

function encrypt(plain) { return CryptoJS.AES.encrypt(plain, WHUT_AES_KEY, WHUT_AES_OPTS).toString(); }
function decrypt(cipher) { return CryptoJS.AES.decrypt(cipher, WHUT_AES_KEY, WHUT_AES_OPTS).toString(CryptoJS.enc.Utf8); }

function signMD5(params) {
  const sorted = Object.keys(params).sort();
  return CryptoJS.MD5(sorted.reduce((s, k) => s + k + params[k], '') + SIGN_SECRET).toString();
}

function hmacSha1(key, data) {
  const c = require('crypto');
  return c.createHmac('sha1', key).update(data).digest('base64');
}

async function apiCall(endpoint, auth, extra = {}) {
  const params = { ...auth, ...extra, timestamp: Math.floor(Date.now() / 1000), version: 1, nonce: random6(), ostype: '5' };
  const sign = signMD5(params);
  const payload = JSON.stringify({ ...params, sign });
  const body = 'ostype=5&data=' + encodeURIComponent(encrypt(payload));
  const resp = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const json = await resp.json();
  if (json.data && json.is_encrypt) return JSON.parse(decrypt(json.data));
  return json;
}

async function beforeRun(auth) { return await apiCall('Run2/beforeRunV260', auth); }

async function ossUpload(content, auth) {
  const sts = await apiCall('WpIndex/getOssSts', auth);
  const expiration = new Date(Date.now() + 3600000).toISOString();
  const policy = JSON.stringify({ expiration, conditions: [['content-length-range', 0, 1073741824]] });
  const policyB64 = Buffer.from(policy).toString('base64');
  const signature = hmacSha1(sts.AccessKeySecret, policyB64);
  const dateStr = new Date().toISOString().substring(0, 10);
  const key = `Public/Upload/file/run_record/632/${dateStr}/${Date.now()}-${Math.floor(150 * Math.random())}.cn`;
  const form = new FormData();
  form.append('key', key); form.append('policy', policyB64);
  form.append('OSSAccessKeyId', sts.AccessKeyId); form.append('signature', signature);
  form.append('x-oss-security-token', sts.SecurityToken);
  form.append('file', new Blob([content], { type: 'text/plain' }), 'f.txt');
  await fetch(OSS_ENDPOINT, { method: 'POST', body: form });
  return key.split('Public/Upload/file/')[1];
}

// SPD 登录
function followRedirect(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0)
        resolve(followRedirect(new URL(res.headers.location, url).href, maxRedirects - 1));
      else resolve(url);
    }).on('error', reject);
  });
}
async function spdLogin(token) {
  const resp = await fetch('https://spd.whut.edu.cn/prod-api/system/user/getInfo', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await resp.json();
  if (data.code !== 200) throw new Error(data.msg || 'token 过期');
  const studentNum = data.user.userName;
  const userName = data.user.nickName || '';
  const encryptedNum = CryptoJS.AES.encrypt(JSON.stringify(studentNum), 'zths@2024$1234567').toString();
  const whutUrl = `https://tzcs.whut.edu.cn/bdlp_h5_fitness_test/public/index.php/index/login/whutLogin?type=3&studentNum=${encryptedNum}`;
  const finalUrl = await followRedirect(whutUrl);
  const parsed = new URL(finalUrl);
  let params = {};
  if (parsed.hash && parsed.hash.includes('?')) params = Object.fromEntries(new URLSearchParams(parsed.hash.split('?')[1]));
  return {
    uid: params.uid, token: params.token, card_id: params.card_id,
    student_num: params.student_num || studentNum, school_id: params.school_id || '5',
    role: params.user_type || '1', course_id: 0, class_id: 0, name: userName,
  };
}

// ══════════════════════════════════════════════════════════════
// 提交跑步（用自定义轨迹和指定时间）
// ══════════════════════════════════════════════════════════════
async function submitRunSynced(auth, trackPts, totalTime, cpIds, mode, gameId, onProgress, job) {
  onProgress && onProgress(10, '提交中');
  try {
    const cpA = WHUT_CP[cpIds[0]], cpB = WHUT_CP[cpIds[1]];
    if (!cpA || !cpB) throw new Error('无效打卡点: ' + cpIds.join(','));

    // 计算距离
    let actualDistM = 0;
    for (let i = 1; i < trackPts.length; i++)
      actualDistM += haversine(trackPts[i-1].a, trackPts[i-1].o, trackPts[i].a, trackPts[i].o);
    const actualDistKm = Math.round(actualDistM) / 1000;
    const durationS = totalTime;
    const paceMinKm = durationS / 60 / (actualDistKm || 1);

    // 相对时间
    let cumDist = 0;
    const pts = trackPts.map((p, i) => {
      if (i > 0) cumDist += haversine(trackPts[i-1].a, trackPts[i-1].o, p.a, p.o);
      return { a: p.a, o: p.o, c: p.c !== undefined ? String(p.c) : '0.00', _relT: Math.round((cumDist / (actualDistM || 1)) * durationS), _lat: p.a, _lng: p.o };
    });

    // 1) beforeRun
    await apiCall('Run2/beforeRunV260', auth);

    // 2) OSS 上传
    const absPts = pts.map(p => { const pt = { a: p.a, o: p.o, c: p.c }; if (p.s !== undefined) pt.s = p.s; if (p.b !== undefined) pt.b = p.b; return pt; });
    const recordFile = await ossUpload(encrypt(JSON.stringify(absPts)), auth);

    // 3) 时间：endTime 为当前时间，startTime 往前推 durationS
    const realNow = Math.floor(Date.now() / 1000);
    const endTime = realNow;
    const startTime = endTime - durationS;

    // 4) 打卡点
    const checkpoints = [];
    let hitA = false, hitB = false;
    for (const p of pts) {
      const absT = startTime + p._relT;
      if (!hitA && haversine(p._lat, p._lng, cpA.lat, cpA.lng) < CP_HIT_RADIUS) {
        hitA = true;
        checkpoints.push({ point_id: cpIds[0], latitude: +p._lat.toFixed(10), longitude: +p._lng.toFixed(10), longtitude: +p._lng.toFixed(10), time: String(absT) });
      }
      if (!hitB && haversine(p._lat, p._lng, cpB.lat, cpB.lng) < CP_HIT_RADIUS) {
        hitB = true;
        checkpoints.push({ point_id: cpIds[1], latitude: +p._lat.toFixed(10), longitude: +p._lng.toFixed(10), longtitude: +p._lng.toFixed(10), time: String(absT) });
      }
    }

    // 5) stopRun
    const result = await apiCall('Run/stopRunV278', auth, {
      role: 2, term_id: 1, game_id: String(gameId || 1), start_time: startTime, end_time: endTime,
      log_data: JSON.stringify(checkpoints), file_img: '', is_running_area_valid: 1,
      mobileDeviceId: 1, mobileModel: 1, mobileOsVersion: 1,
      step_info: JSON.stringify({ interval: 60, list: [] }),
      step_num: 1, used_time: durationS, distance: actualDistKm,
      record_img: '', record_file: recordFile,
    });

    const res = {
      record_id: result.record_id, status: result.record_status || result.status,
      distance: actualDistKm, pace: `${Math.floor(paceMinKm)}'${String(Math.floor((paceMinKm % 1) * 60)).padStart(2, '0')}"`,
      time: durationS, reason: result.record_failed_reason || result.info || '',
    };
    onProgress && onProgress(100, '完成');
    console.log('[submit] result:', JSON.stringify(res));
    return res;
  } catch (e) {
    console.log('[submit] error:', e.message);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// 持久化
// ══════════════════════════════════════════════════════════════

function ensureDataDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheTime < CACHE_TTL) return settingsCache;
  try {
    settingsCache = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    settingsCacheTime = now;
    return settingsCache;
  } catch { return 'null'; }
}

function saveSettings(data) {
  settingsCache = data;
  settingsCacheTime = Date.now();
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, data, 'utf-8');
}

function loadHistory() {
  const now = Date.now();
  if (historyCache && now - historyCacheTime < CACHE_TTL) return historyCache;
  try {
    historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    historyCacheTime = now;
  } catch { historyCache = []; }
  return historyCache;
}

function saveHistory(result) {
  const h = loadHistory();
  h.unshift({ ...result, createdAt: new Date().toISOString() });
  if (h.length > 50) h.length = 50;
  historyCache = h;
  historyCacheTime = Date.now();
  ensureDataDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf-8');
}

// ══════════════════════════════════════════════════════════════
// HTTP 服务器
// ══════════════════════════════════════════════════════════════

function getLocalIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (name.toLowerCase().includes('vmware') || name.toLowerCase().includes('vethernet')) continue;
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ name, ip: net.address });
    }
  }
  return ips;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(JSON.stringify(data));
}

function serveFile(filePath, data, mime, res, req) {
  const acceptGzip = req.headers['accept-encoding'] || '';
  // 文本类文件才 gzip
  const textTypes = ['text/', 'application/javascript', 'application/json'];
  const isText = textTypes.some(t => mime.startsWith(t));
  let gz = null;

  if (isText && acceptGzip.includes('gzip')) {
    gz = zlib.gzipSync(data);
  }

  // 写入缓存
  staticCache.set(filePath, { raw: data, gz, mime, time: Date.now() });
  // 控制缓存大小
  if (staticCache.size > 50) {
    const oldest = staticCache.keys().next().value;
    if (oldest) staticCache.delete(oldest);
  }

  const headers = {
    'Content-Type': mime,
    'Vary': 'Accept-Encoding',
    'Cache-Control': 'no-cache, must-revalidate',
  };
  if (gz) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(gz || data);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const time = new Date().toLocaleTimeString();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '-';
  console.log(`[${time}] ${ip} ${req.method} ${urlPath}`);

  // ═══ WHUT API 路由 ═══

  if (urlPath === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(loadSettings());
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        saveSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    }
    return;
  }

  if (urlPath === '/api/whut/login' && req.method === 'POST') {
    try {
      const { url: spdUrl, token: directToken } = await parseBody(req);
      let token = directToken;
      if (!token && spdUrl) {
        try {
          const u = new URL(spdUrl);
          if (u.hash && u.hash.includes('?')) token = new URLSearchParams(u.hash.split('?')[1]).get('token');
          if (!token) token = u.searchParams.get('token');
        } catch { /* ignore */ }
      }
      if (!token) { sendJSON(res, 400, { error: '未找到 token' }); return; }
      const auth = await spdLogin(token);
      sendJSON(res, 200, auth);
    } catch (e) {
      sendJSON(res, 401, { error: e.message });
    }
    return;
  }

  if (urlPath === '/api/whut/check-auth' && req.method === 'POST') {
    try {
      const { auth } = await parseBody(req);
      if (!auth || !auth.token) { sendJSON(res, 401, { ok: false, error: '缺少认证' }); return; }
      await beforeRun(auth);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 401, { ok: false, error: '登录已过期，请重新登录' });
    }
    return;
  }

  if (urlPath === '/api/whut/submit' && req.method === 'POST') {
    try {
      const { auth, trackPts, totalTime, cpIds, mode, gameId } = await parseBody(req);
      if (!auth || !auth.token) { sendJSON(res, 400, { error: '缺少认证' }); return; }
      if (!trackPts || trackPts.length < 2) { sendJSON(res, 400, { error: '轨迹点不足' }); return; }
      if (!cpIds || cpIds.length < 2) { sendJSON(res, 400, { error: '至少需要2个打卡点' }); return; }

      const jobId = Date.now().toString(36) + '-' + (++jobCounter);
      const job = { id: jobId, status: 'running', progress: 0, message: '初始化', result: null, error: null };
      jobs.set(jobId, job);

      submitRunSynced(auth, trackPts, totalTime || 666, cpIds, mode || 'scored', gameId || 1, (pct, msg) => {
        job.progress = pct;
        job.message = msg;
      }, job).then(result => {
        job.status = 'done';
        job.result = result;
        job.progress = 100;
        job.message = '完成';
        saveHistory(result);
      }).catch(err => {
        job.status = 'error';
        job.error = err.message;
        job.message = err.message;
      });

      sendJSON(res, 200, { jobId });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (urlPath.startsWith('/api/whut/job/') && req.method === 'GET') {
    const jobId = urlPath.split('/api/whut/job/')[1];
    const job = jobs.get(jobId);
    if (!job) { sendJSON(res, 404, { error: '任务不存在' }); return; }
    sendJSON(res, 200, {
      status: job.status,
      progress: job.progress,
      message: job.message,
      result: job.result,
      error: job.error,
    });
    return;
  }

  if (urlPath === '/api/whut/history' && req.method === 'GET') {
    sendJSON(res, 200, loadHistory());
    return;
  }

  // ═══ 图片上传（base64 → 文件） ═══
  if (urlPath === '/api/upload' && req.method === 'POST') {
    try {
      const { data } = await parseBody(req);
      const match = data.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) { sendJSON(res, 400, { error: '无效的图片数据' }); return; }
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const fileName = `map_${Date.now()}.${ext}`;
      ensureDataDir();
      fs.writeFileSync(path.join(__dirname, 'data', fileName), buffer);
      sendJSON(res, 200, { path: `data/${fileName}` });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ═══ 静态文件（内存缓存 + gzip） ═══
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  // 检查缓存
  const cached = staticCache.get(filePath);
  if (cached && Date.now() - cached.time < STATIC_TTL) {
    const acceptGzip = req.headers['accept-encoding'] || '';
    const useGzip = acceptGzip.includes('gzip') && cached.gz;
    const h = { 'Content-Type': cached.mime, 'Cache-Control': 'no-cache, must-revalidate' };
    if (useGzip) h['Content-Encoding'] = 'gzip';
    res.writeHead(200, h);
    res.end(useGzip ? cached.gz : cached.raw);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 尝试 index.html fallback（SPA 路由）
      if (ext === '' || ext === '.html') {
        filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err2, data2) => {
          if (err2) { res.writeHead(404); res.end('Not Found'); return; }
          serveFile(filePath, data2, 'text/html; charset=utf-8', res, req);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    serveFile(filePath, data, mime, res, req);
  });
});

server.maxHeadersCount = 2000;
server.timeout = 120000;
server.keepAliveTimeout = 15000;

// ═══ HTTPS（可选） ═══
const HTTPS_PORT = 6661;
const CERT_DIR = path.join(__dirname, 'data');
const certFile = path.join(CERT_DIR, 'cert.pem');
const keyFile = path.join(CERT_DIR, 'key.pem');

(function tryHTTPS() {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    try {
      const cp = require('child_process');
      cp.execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 365 -nodes -subj "/CN=localhost/O=huipao"`, { stdio: 'ignore' });
      console.log('已生成自签名证书');
    } catch (e) {
      console.log('HTTPS 不可用（需要安装 openssl 或提供 cert.pem/key.pem）');
      return;
    }
  }
  try {
    const https = require('https');
    const credentials = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    const httpsServer = https.createServer(credentials, (req, res) => server.emit('request', req, res));
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS  https://localhost:${HTTPS_PORT}/`);
    });
  } catch (e) {
    console.log('HTTPS 启动失败:', e.message);
  }
})();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP   http://localhost:${PORT}/`);
  const ips = getLocalIPs();
  ips.forEach(({ name, ip }) => console.log(`       http://${ip}:${PORT}/`));
});
