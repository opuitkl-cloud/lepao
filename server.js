const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 8766;
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const AUTH_FILE = path.join(__dirname, 'data', 'whut_auth.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'whut_history.json');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// ══════════════════════════════════════════════════════════════
// WHUT API 常量
// ══════════════════════════════════════════════════════════════
const WHUT_AES_KEY = Buffer.from('Wet2C8d34f62ndi3', 'utf-8');
const WHUT_AES_IV = Buffer.from('K6iv85jBD8jgf32D', 'utf-8');
const WHUT_SIGN_SECRET = 'rDJiNB9j7vD2';
const SPD_AES_PASSWORD = 'zths@2024$1234567';
const API_BASE = 'https://tzcs.whut.edu.cn/v3/api.php';
const OSS_BUCKET = 'lptiyu-ps5';
const OSS_ENDPOINT = `https://${OSS_BUCKET}.oss-cn-hangzhou.aliyuncs.com`;

const WHUT_CP = {
  '14': { lat: 30.509007, lng: 114.329637, name: '体育场北' },
  '15': { lat: 30.507606, lng: 114.329621, name: '体育场南' },
  '16': { lat: 30.508397, lng: 114.328302, name: '学生公寓南二栋' },
  '17': { lat: 30.506941, lng: 114.327894, name: '南六宿舍楼' },
  '18': { lat: 30.505217, lng: 114.331129, name: '体育馆东门' },
};

const jobs = new Map();
let jobCounter = 0;

// ══════════════════════════════════════════════════════════════
// Crypto 工具
// ══════════════════════════════════════════════════════════════

function aesEncrypt(plain) {
  const cipher = crypto.createCipheriv('aes-128-cbc', WHUT_AES_KEY, WHUT_AES_IV);
  return cipher.update(plain, 'utf-8', 'base64') + cipher.final('base64');
}

function aesDecrypt(ciphertext) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', WHUT_AES_KEY, WHUT_AES_IV);
  return decipher.update(ciphertext, 'base64', 'utf-8') + decipher.final('utf-8');
}

function md5Sign(params) {
  const sorted = Object.keys(params).sort();
  const str = sorted.reduce((s, k) => s + k + params[k], '') + WHUT_SIGN_SECRET;
  return crypto.createHash('md5').update(str).digest('hex');
}

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest('base64');
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dL / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// EVP_BytesToKey — 兼容 CryptoJS 的密钥派生
function evpBytesToKey(password, salt, keySize, ivSize) {
  const passBuf = Buffer.from(password, 'utf-8');
  let result = Buffer.alloc(0);
  let last = Buffer.alloc(0);
  while (result.length < keySize + ivSize) {
    const input = Buffer.concat([last, passBuf, salt]);
    const hash = crypto.createHash('md5').update(input).digest();
    result = Buffer.concat([result, hash]);
    last = hash;
  }
  return { key: result.subarray(0, keySize), iv: result.subarray(keySize, keySize + ivSize) };
}

// CryptoJS 兼容的 AES-256-CBC 加密（EVP_BytesToKey + OpenSSL 格式）
function cryptoJsEncrypt(plaintext, password) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(password, salt, 32, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  // OpenSSL 格式: "Salted__" + salt + encrypted
  return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
}

function random6() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════
// WHUT API 函数
// ══════════════════════════════════════════════════════════════

async function apiCall(endpoint, auth, extra = {}) {
  const params = {
    ...auth,
    ...extra,
    timestamp: Math.floor(Date.now() / 1000),
    version: 1,
    nonce: random6(),
    ostype: '5',
  };
  const sign = md5Sign(params);
  const payload = JSON.stringify({ ...params, sign });
  const body = 'ostype=5&data=' + encodeURIComponent(aesEncrypt(payload));
  const resp = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json();
  if (json.data && json.is_encrypt) return JSON.parse(aesDecrypt(json.data));
  return json;
}

// 心跳
async function getTimestamp(auth) {
  const { role, ...authNoRole } = auth;
  return await apiCall('Run/getTimestampV278', { ...authNoRole, term_id: '0' });
}

// SPD 登录
async function spdLogin(token) {
  // 1) 从 SPD 获取学号
  const resp = await fetch('https://spd.whut.edu.cn/prod-api/system/user/getInfo', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://spd.whut.edu.cn/h5/',
      'Origin': 'https://spd.whut.edu.cn',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SPD API ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (data.code !== 200) throw new Error(data.msg || 'token 过期或无效');
  const studentNum = data.user.userName;
  const userName = data.user.nickName || '';

  // 2) 加密学号（CryptoJS 兼容的 AES-256-CBC）
  const encryptedNum = cryptoJsEncrypt(JSON.stringify(studentNum), SPD_AES_PASSWORD);

  // 3) 调 whutLogin，从 302 跳转 URL 提取认证参数
  const whutUrl = `https://tzcs.whut.edu.cn/bdlp_h5_fitness_test/public/index.php/index/login/whutLogin?type=3&studentNum=${encodeURIComponent(encryptedNum)}`;
  const r1 = await fetch(whutUrl, { redirect: 'manual' });
  if (r1.status !== 302) throw new Error('whutLogin 返回值异常: ' + r1.status);
  const location = r1.headers.get('location') || '';
  // 成功路径: h5whlg/ 开头；失败路径: casLogin.html?type=1
  if (location.includes('casLogin.html')) throw new Error('whutLogin 认证失败，链接可能已过期');

  // 4) 从 hash 中提取 auth 参数
  const parsedUrl = new URL(location);
  let params = {};
  if (parsedUrl.hash && parsedUrl.hash.includes('?')) {
    params = Object.fromEntries(new URLSearchParams(parsedUrl.hash.split('?')[1]));
  }
  if (!params.uid || !params.token) throw new Error('未能获取认证参数');

  return {
    uid: params.uid || '',
    token: params.token || '',
    card_id: params.card_id || '',
    student_num: params.student_num || studentNum,
    school_id: params.school_id || '5',
    role: params.user_type || '1',
    course_id: params.course_id || 0,
    class_id: 0,
    name: userName,
  };
}

// OSS 上传
async function ossUpload(content, auth) {
  const sts = await apiCall('WpIndex/getOssSts', auth);
  const expiration = new Date(Date.now() + 3600000).toISOString();
  const policy = JSON.stringify({ expiration, conditions: [['content-length-range', 0, 1073741824]] });
  const policyB64 = Buffer.from(policy).toString('base64');
  const signature = hmacSha1(sts.AccessKeySecret, policyB64);
  const dateStr = new Date().toISOString().substring(0, 10);
  const key = `Public/Upload/file/run_record/632/${dateStr}/${Date.now()}-${Math.floor(150 * Math.random())}.cn`;
  const form = new FormData();
  form.append('key', key);
  form.append('policy', policyB64);
  form.append('OSSAccessKeyId', sts.AccessKeyId);
  form.append('signature', signature);
  form.append('x-oss-security-token', sts.SecurityToken);
  form.append('file', new Blob([content], { type: 'text/plain' }), 'f.txt');
  await fetch(OSS_ENDPOINT, { method: 'POST', body: form });
  return key.split('Public/Upload/file/')[1];
}

// ══════════════════════════════════════════════════════════════
// 提交跑步（异步 + 进度通知）
// ══════════════════════════════════════════════════════════════

async function submitRunSynced(auth, trackPts, totalTime, cpIds, mode, onProgress) {
  const endpoint = mode === 'scored' ? 'Run/stopRunV278' : 'Run/stopFreeRunV220';

  // 计算每个点的累计距离和相对时间
  let cumDist = 0;
  const totalDist = trackPts.reduce((sum, p, i) => {
    if (i === 0) return 0;
    return sum + haversine(trackPts[i - 1].a, trackPts[i - 1].o, p.a, p.o);
  }, 0);

  const ptsWithRelT = trackPts.map((p, i) => {
    if (i > 0) cumDist += haversine(trackPts[i - 1].a, trackPts[i - 1].o, p.a, p.o);
    return { ...p, _relT: Math.round((cumDist / (totalDist || 1)) * totalTime) };
  });
  const actualDistKm = totalDist / 1000;
  const paceMinKm = totalTime / 60 / (actualDistKm || 1);

  // 开始
  const startTime = Math.floor(Date.now() / 1000);
  const endTime = startTime + totalTime;

  onProgress && onProgress(10, '开始跑步');

  // 心跳
  try { await getTimestamp(auth); } catch (e) {}
  onProgress && onProgress(20, '运动中');

  // 构建打卡点命中（在轨迹中找第一个距离打卡点 < 200m 的点）
  const checkpoints = [];
  for (const cpId of cpIds) {
    const cp = WHUT_CP[cpId];
    if (!cp) continue;
    for (const p of ptsWithRelT) {
      if (haversine(p.a, p.o, cp.lat, cp.lng) <= 200) {
        checkpoints.push({
          point_id: cpId,
          latitude: Number(p.a.toFixed(10)),
          longitude: Number(p.o.toFixed(10)),
          longtitude: Number(p.o.toFixed(10)),
          time: String(startTime + p._relT),
        });
        break;
      }
    }
  }

  // 等待运动时长
  const waitMs = Math.max(0, endTime * 1000 - Date.now());
  if (waitMs > 0) {
    onProgress && onProgress(40, `等待 ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  // 结束心跳
  try { await getTimestamp(auth); } catch (e) {}
  onProgress && onProgress(60, '上传轨迹');

  // OSS 上传（加密轨迹数据）
  const uploadPts = ptsWithRelT.map(p => {
    const pt = { a: p.a, o: p.o, c: p.c || '0.00' };
    if (p.s !== undefined) pt.s = p.s;
    if (p.b !== undefined) pt.b = p.b;
    return pt;
  });
  const recordFile = await ossUpload(aesEncrypt(JSON.stringify(uploadPts)), auth);

  onProgress && onProgress(80, '提交结果');
  await sleep(3000);

  const result = await apiCall(endpoint, auth, {
    role: 2,
    term_id: 1,
    game_id: '1',
    start_time: startTime,
    end_time: endTime,
    log_data: JSON.stringify(checkpoints),
    file_img: '',
    is_running_area_valid: 1,
    mobileDeviceId: 1,
    mobileModel: 1,
    mobileOsVersion: 1,
    step_info: JSON.stringify({ interval: 60, list: [] }),
    step_num: 1,
    used_time: totalTime,
    distance: actualDistKm,
    record_img: '',
    record_file: recordFile,
  });

  onProgress && onProgress(100, '完成');

  return {
    record_id: result.record_id,
    status: result.record_status || result.status,
    distance: actualDistKm,
    pace: `${Math.floor(paceMinKm)}'${String(Math.floor((paceMinKm % 1) * 60)).padStart(2, '0')}"`,
    time: totalTime,
    reason: result.record_failed_reason || result.info || '',
    endpoint,
    checkpoints_hit: checkpoints.map(c => ({ point_id: c.point_id, time: c.time })),
    startTime: new Date(startTime * 1000).toISOString(),
    endTime: new Date(endTime * 1000).toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// 持久化
// ══════════════════════════════════════════════════════════════

function ensureDataDir() {
  const dir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveAuth(auth) {
  ensureDataDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf-8');
}

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return null;
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

  // 设置（原有）
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

  // POST /api/whut/login — SPD 登录
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
      saveAuth(auth);
      sendJSON(res, 200, auth);
    } catch (e) {
      sendJSON(res, 401, { error: e.message });
    }
    return;
  }

  // POST /api/whut/submit — 创建异步提交任务
  if (urlPath === '/api/whut/submit' && req.method === 'POST') {
    try {
      const { auth, trackPts, totalTime, cpIds, mode } = await parseBody(req);
      if (!auth || !auth.token) { sendJSON(res, 400, { error: '缺少认证' }); return; }
      if (!trackPts || trackPts.length < 2) { sendJSON(res, 400, { error: '轨迹点不足' }); return; }
      if (!cpIds || cpIds.length < 2) { sendJSON(res, 400, { error: '至少需要2个打卡点' }); return; }

      const jobId = Date.now().toString(36) + '-' + (++jobCounter);
      const job = { id: jobId, status: 'running', progress: 0, message: '初始化', result: null, error: null };
      jobs.set(jobId, job);

      // 后台异步执行
      submitRunSynced(auth, trackPts, totalTime || 3600, cpIds, mode || 'free', (pct, msg) => {
        job.progress = pct;
        job.message = msg;
      }).then(result => {
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

  // GET /api/whut/job/:id — 轮询任务状态
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

  // GET /api/whut/history — 历史记录
  if (urlPath === '/api/whut/history' && req.method === 'GET') {
    sendJSON(res, 200, loadHistory());
    return;
  }

  // GET /api/whut/auth — 获取保存的认证
  if (urlPath === '/api/whut/auth' && req.method === 'GET') {
    const auth = loadAuth();
    sendJSON(res, 200, auth || {});
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
