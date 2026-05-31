const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CryptoJS = require('crypto-js');

const PORT = 6660;
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'whut_history.json');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

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
  '14': { lat: 30.509007, lng: 114.329637, name: '体育场北' },
  '15': { lat: 30.507606, lng: 114.329621, name: '体育场南' },
  '16': { lat: 30.508397, lng: 114.328302, name: '学生公寓南二栋' },
  '17': { lat: 30.506941, lng: 114.327894, name: '南六宿舍楼' },
  '18': { lat: 30.505217, lng: 114.331129, name: '体育馆东门' },
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
async function submitRunSynced(auth, trackPts, totalTime, cpIds, mode, onProgress, job) {
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

    // 3) 时间
    const realNow = Math.floor(Date.now() / 1000);
    const startTime = realNow - 5;
    const endTime = startTime + durationS;

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
      role: 2, term_id: 1, game_id: '1', start_time: startTime, end_time: endTime,
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

function saveHistory(result) {
  ensureDataDir();
  let history = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  history.unshift({ ...result, createdAt: new Date().toISOString() });
  if (history.length > 50) history = history.slice(0, 50);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return [];
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

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${req.method} ${urlPath}`);

  // ═══ WHUT API 路由 ═══

  if (urlPath === '/api/settings') {
    if (req.method === 'GET') {
      const data = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf-8') : 'null';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        fs.writeFileSync(SETTINGS_FILE, body, 'utf-8');
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

  if (urlPath === '/api/whut/submit' && req.method === 'POST') {
    try {
      const { auth, trackPts, totalTime, cpIds, mode } = await parseBody(req);
      if (!auth || !auth.token) { sendJSON(res, 400, { error: '缺少认证' }); return; }
      if (!trackPts || trackPts.length < 2) { sendJSON(res, 400, { error: '轨迹点不足' }); return; }
      if (!cpIds || cpIds.length < 2) { sendJSON(res, 400, { error: '至少需要2个打卡点' }); return; }

      const jobId = Date.now().toString(36) + '-' + (++jobCounter);
      const job = { id: jobId, status: 'running', progress: 0, message: '初始化', result: null, error: null };
      jobs.set(jobId, job);

      submitRunSynced(auth, trackPts, totalTime || 666, cpIds, mode || 'scored', (pct, msg) => {
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

  // ═══ 静态文件 ═══
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  const ips = getLocalIPs();
  ips.forEach(({ name, ip }) => console.log(`  ${name}: http://${ip}:${PORT}/`));
});
