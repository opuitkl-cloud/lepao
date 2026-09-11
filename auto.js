// 无人值守自动提交
// 每天在 [startHour, endHour) 之间随机挑一个时刻，从 data/presets/ 里随机选一条预设提交。
// 每次提交前重新登录（token 不持久，登一次约 1 秒），所以不需要维护登录态。
//
// 用法：
//   node auto.js          常驻运行
//   node auto.js --once   立刻提交一次然后退出（用来验证账密和预设是否可用）

const fs = require('fs');
const path = require('path');
const { casLogin, spdLogin, submitRunSynced } = require('./server.js');

const CONFIG_FILE = path.join(__dirname, 'data', 'auto.json');
const STATE_FILE  = path.join(__dirname, 'data', 'auto-state.json');
const LOG_FILE    = path.join(__dirname, 'data', 'auto.log');
const PRESETS_DIR = path.join(__dirname, 'data', 'presets');

const TICK_MS  = 60 * 1000;       // 每 60 秒检查一次，而不是睡一整天：
                                  // 手机休眠唤醒、系统改时间、进程重启都能自愈
const RETRY_MS = 10 * 60 * 1000;  // 失败后 10 分钟重试
const MAX_FAILS = 5;              // 连续失败这么多次就放弃当天

let cfg = null;
let state = loadJSON(STATE_FILE, {});
let fails = 0;
let busy = false;

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 日志写不了不该拖垮主流程 */ }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

// 把 9 / 14.5 这样的小时数显示成 09:00 / 14:30
function fmtHour(h) {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8'); } catch (e) { log('状态写入失败: ' + e.message); }
}

// 在今天的 [startHour, endHour) 里随机取一个时刻。
// 已经进窗口就只取剩余时间；窗口已过返回 null。
// 下限用 now + 1 分钟，保证不会选到一个已经过去的时刻。
// startHour/endHour 支持小数（14.5 = 14:30）。
function pickTarget(now, startHour, endHour, rand = Math.random) {
  const at = (h) => { const d = new Date(now); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); return d.getTime(); };
  const lo = Math.max(at(startHour), now + 60000);
  const hi = at(endHour);
  if (lo >= hi) return null;
  return lo + Math.floor(rand() * (hi - lo));
}

function loadPresets() {
  let files = [];
  try { files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const p = loadJSON(path.join(PRESETS_DIR, f), null);
    if (p && Array.isArray(p.trackPts) && p.trackPts.length >= 2 && Array.isArray(p.cpIds) && p.cpIds.length >= 2) {
      out.push({
        name: p.name || f.replace(/\.json$/, ''),
        gameId: p.gameId || 1,
        totalTime: p.totalTime || 666,
        cpIds: p.cpIds,
        trackPts: p.trackPts,
      });
    } else {
      log(`跳过格式不对的预设 ${f}（需要 trackPts 和 cpIds 各至少 2 项）`);
    }
  }
  return out;
}

// 登录 + 提交一次。成功或彻底放弃都会写 lastSubmitDate，中间失败则安排重试。
async function submitOnce(day) {
  const presets = loadPresets();
  if (!presets.length) {
    log(`data/presets/ 里没有可用预设，10 分钟后再看。请先在网页上画好轨迹并点「导出为预设」`);
    state.targetAt = Date.now() + RETRY_MS;
    saveState();
    return;
  }

  const p = presets[Math.floor(Math.random() * presets.length)];
  log(`选中预设「${p.name}」：gameId=${p.gameId}，${p.trackPts.length} 个点，${p.totalTime}s，打卡点 ${p.cpIds.join('/')}`);

  try {
    const auth = await spdLogin(await casLogin(cfg.username, cfg.password));
    log(`登录成功：${auth.name || auth.student_num}`);
    const res = await submitRunSynced(auth, p.trackPts, p.totalTime, p.cpIds, 'scored', p.gameId, () => {}, null);
    log(`提交成功：记录 ${res.record_id}，距离 ${res.distance} km，配速 ${res.pace}${res.reason ? '，说明 ' + res.reason : ''}`);
    state.lastSubmitDate = day;
    fails = 0;
  } catch (e) {
    fails++;
    log(`提交失败（连续第 ${fails} 次）：${e.message}`);
    if (fails >= MAX_FAILS) {
      log(`连续失败 ${MAX_FAILS} 次，今天不再尝试`);
      state.lastSubmitDate = day;
      fails = 0;
    } else {
      state.targetAt = Date.now() + RETRY_MS;
    }
  }
  saveState();
}

async function tick() {
  if (busy) return;          // 上一轮还没跑完（登录+提交约几秒），别叠加
  busy = true;
  try {
    const day = today();
    if (state.lastSubmitDate === day) return;      // 今天已完成

    if (state.targetDate !== day || !state.targetAt) {
      const t = pickTarget(Date.now(), cfg.startHour, cfg.endHour);
      if (t === null) {
        log(`今天的时间窗口（${fmtHour(cfg.startHour)} - ${fmtHour(cfg.endHour)}）已过，跳过，明天再来`);
        state.targetDate = day;
        state.targetAt = null;
        state.lastSubmitDate = day;
        saveState();
        return;
      }
      state.targetDate = day;
      state.targetAt = t;
      saveState();
      log(`今天的目标时刻：${fmtTime(t)}（窗口 ${fmtHour(cfg.startHour)} - ${fmtHour(cfg.endHour)}）`);
    }

    if (Date.now() < state.targetAt) return;
    await submitOnce(day);
  } catch (e) {
    log('本轮异常：' + ((e && e.message) || e));
  } finally {
    busy = false;
  }
}

function main() {
  cfg = loadJSON(CONFIG_FILE, null);
  if (!cfg || !cfg.username || !cfg.password) {
    console.error(`缺少或格式不对的配置文件：${CONFIG_FILE}`);
    console.error('需要这样的内容（注意这个文件有明文密码，已在 .gitignore 里）：');
    console.error(JSON.stringify({ username: '你的CAS用户名', password: '你的密码', startHour: 9, endHour: 18 }, null, 2));
    process.exit(1);
  }
  cfg.startHour = typeof cfg.startHour === 'number' ? cfg.startHour : 9;
  cfg.endHour   = typeof cfg.endHour   === 'number' ? cfg.endHour   : 18;

  const presets = loadPresets();
  log(`自动提交启动：窗口 ${fmtHour(cfg.startHour)} - ${fmtHour(cfg.endHour)}，可用预设 ${presets.length} 条，账号 ${cfg.username}`);
  if (!presets.length) log(`注意：${PRESETS_DIR} 里还没有预设，需要先在网页上画轨迹并点「导出为预设」`);

  if (process.argv.includes('--once')) {
    log('--once：立刻提交一次然后退出');
    submitOnce(today()).then(() => process.exit(0));
    return;
  }

  tick();
  setInterval(tick, TICK_MS);
}

if (require.main === module) main();

module.exports = { pickTarget, loadPresets, today };
