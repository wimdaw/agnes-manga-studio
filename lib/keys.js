/**
 * keys.js — Agnes API Key 池与轮换
 * ------------------------------------------------------------------
 * 免费档每把 Key 的 RPM 有上限（官方文档写的是 ≤ 20），单 Key 跑一集
 * 三四十个镜头会一直卡在限流上。这里把多把 Key 收成一个池子：
 *   · 轮换：round_robin（默认）按顺序摊开；least_used 优先用总调用数最少的
 *   · 限流：每把 Key 一个 60 秒滑窗，窗口内达到 rpm 就先跳过它
 *   · 冷却：429 短暂冷却、额度类错误长冷却、连续认证失败自动停用
 *   · 兜底：池子为空时仍用设置里旧的单 Key，老配置不用改就能继续跑
 *
 * 为什么单独一个 keys.json：
 *   明文密钥不能跟着「项目导出 / 全量备份」一起走，否则备份文件一转发就泄露。
 *   所以密钥不进 db.json，也不进任何导出逻辑。
 *
 * 与 store.js 的关系是单向的：keys 读 store 的设置，store 不认识 keys。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const FILE_VERSION = 1;
/** 默认上限；实际值读设置 key_pool_max，允许 1..5000 */
const DEFAULT_MAX_KEYS = 20;
const WINDOW_MS = 60 * 1000;
const LEGACY_ID = '__legacy__';
/** 一把 Key 连续认证失败这么多次就自动停用，避免每轮都拿它试错 */
const AUTH_FAIL_LIMIT = 3;

let FILE = null;
let DATA = null;                 // { version, cursor, migrated, keys: [] }
let windows = new Map();         // keyId -> [timestamp, ...] 60 秒滑窗
let persistTimer = null;

const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();

function emptyData() {
  return { version: FILE_VERSION, cursor: 0, migrated: false, keys: [] };
}

// ── 基础工具 ─────────────────────────────────────────────────
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function defaultRpm() {
  try { return clampInt(store.getSettings().key_default_rpm, 1, 600, 20); } catch { return 20; }
}

function cooldownBase() {
  try { return clampInt(store.getSettings().key_cooldown_seconds, 5, 3600, 60); } catch { return 60; }
}

/**
 * 密钥池上限。
 * 免费档常见 20 把就够跑一集；批量导入几百把的场景（换号池）需要能调大，
 * 所以放成设置项而不是常量。上限 5000 是防手滑填 999999 后界面卡死。
 */
function maxKeys() {
  try { return clampInt(store.getSettings().key_pool_max, 1, 5000, DEFAULT_MAX_KEYS); } catch { return DEFAULT_MAX_KEYS; }
}

function rotationMode() {
  try {
    const m = String(store.getSettings().key_rotation_mode || '');
    return m === 'least_used' ? 'least_used' : 'round_robin';
  } catch { return 'round_robin'; }
}

/**
 * Key 清洗：粘贴时常带着引号、Bearer 前缀、行尾逗号。
 * 这些不洗掉的话，报错会是 401，而用户看着界面上「明明填对了」。
 */
function cleanKey(raw) {
  let k = String(raw == null ? '' : raw).trim();
  // 两轮：先剥尾巴上的逗号分号，才能露出被包住的引号；只做一轮会剩半个引号
  for (let i = 0; i < 2; i++) {
    k = k.replace(/[,，;；]+$/, '').trim();
    k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
    k = k.replace(/^Bearer\s+/i, '').trim();
  }
  return k;
}

function looksLikeKey(s) {
  const k = cleanKey(s);
  return k.length >= 8 && !/\s/.test(k);
}

function newId() {
  return `key_${nowMs().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ── 读写 ─────────────────────────────────────────────────────
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = cleanKey(raw.key);
  if (!key) return null;
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  return {
    id: String(raw.id || newId()),
    label: String(raw.label || '').slice(0, 40) || '未命名密钥',
    key,
    enabled: raw.enabled !== false,
    auto_disabled: raw.auto_disabled === true,
    rpm: clampInt(raw.rpm, 1, 600, defaultRpm()),
    created_at: String(raw.created_at || nowIso()),
    stats: {
      ok: Number(stats.ok) || 0,
      fail: Number(stats.fail) || 0,
      last_used_at: stats.last_used_at || '',
      last_error: String(stats.last_error || '').slice(0, 300),
    },
    // 冷却时间用时间戳存：重启后仍然有效，过期了自然不算
    cooldown_until: Number(raw.cooldown_until) || 0,
    auth_failures: Number(raw.auth_failures) || 0,
  };
}

function readFile() {
  if (!FILE || !fs.existsSync(FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const data = emptyData();
    data.cursor = Number(parsed.cursor) || 0;
    data.migrated = parsed.migrated === true;
    data.keys = (Array.isArray(parsed.keys) ? parsed.keys : []).map(normalizeEntry).filter(Boolean);
    return data;
  } catch {
    // 密钥文件坏了不能静默清空 —— 挪到一边，用户还能手动捞回来
    try { fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    return null;
  }
}

function persistNow() {
  if (!FILE || !DATA) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(DATA, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* 写盘失败不影响本次进程内的轮换 */ }
}

/** 统计数字每次请求都变，逐次写盘太浪费，攒 800ms 写一次 */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 800);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

// ── 初始化 ───────────────────────────────────────────────────
/**
 * @param {string} home 数据目录（与 store 相同）
 * @returns {{migrated:boolean, total:number}}
 */
function init(home) {
  FILE = path.join(home, 'keys.json');
  windows = new Map();
  const existed = fs.existsSync(FILE);
  DATA = readFile();
  if (!DATA) {
    DATA = emptyData();
    // 只有「从来没建过密钥池」才算升级迁移。已经建过又清空的，不再回灌旧 Key ——
    // 否则用户明明删了 Key，重启一次它又回来了。
    if (!existed) DATA.migrated = false;
  }

  let migrated = false;
  if (!existed && !DATA.keys.length) {
    const legacy = String(store.getRawKey() || '').trim();
    if (legacy) {
      DATA.keys.push(normalizeEntry({ label: '默认密钥（从旧设置迁移）', key: legacy }));
      DATA.migrated = true;
      migrated = true;
      // 迁移而不是复制：两处都留着，用户在任意一处改了，另一处就是旧的，
      // 排查起来会怀疑人生。旧字段清空后只作为「池子空时」的兜底。
      store.clearSetting('agnes_api_key');
    }
  }

  if (!existed || migrated) persistNow();
  return { migrated, total: DATA.keys.length };
}

/** 测试用：把内存状态重置到「未初始化」，避免用例之间互相污染 */
function _resetForTest(home) {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  FILE = home ? path.join(home, 'keys.json') : null;
  DATA = null;
  windows = new Map();
}

function ready() { return !!DATA; }

// ── 滑窗限流 ─────────────────────────────────────────────────
function pruneWindow(id, t = nowMs()) {
  const arr = windows.get(id);
  if (!arr || !arr.length) return [];
  const keep = arr.filter((ts) => t - ts < WINDOW_MS);
  if (keep.length) windows.set(id, keep);
  else windows.delete(id);
  return keep;
}

function usedInWindow(id) {
  return pruneWindow(id).length;
}

function rpmLeft(entry, t = nowMs()) {
  if (!entry.rpm || entry.rpm <= 0) return Infinity;
  return entry.rpm - pruneWindow(entry.id, t).length;
}

function cooldownLeftMs(entry, t = nowMs()) {
  return Math.max(0, (Number(entry.cooldown_until) || 0) - t);
}

function markUse(entry) {
  const arr = pruneWindow(entry.id);
  arr.push(nowMs());
  windows.set(entry.id, arr);
}

// ── 选 Key ───────────────────────────────────────────────────
function legacyLease() {
  const key = String(store.getRawKey() || '').trim();
  if (!key) return null;
  return { id: LEGACY_ID, key, label: '旧版单 Key', rpm: 0, legacy: true };
}

function eligible(entry, t, exclude) {
  if (!entry.enabled) return false;
  if (exclude && exclude.has(entry.id)) return false;
  if (cooldownLeftMs(entry, t) > 0) return false;
  if (rpmLeft(entry, t) <= 0) return false;
  return true;
}

/**
 * 取一把可用 Key。取到即记账（占用一个 RPM 名额），所以不要拿它做「有没有 Key」的判断，
 * 那种场景请用 hasAny()。
 * @param {{exclude?:Set<string>}} opts 本次请求已经试过、要跳过的 id
 * @returns {{id:string,key:string,label:string,rpm:number,legacy?:boolean}|null}
 */
function pick(opts = {}) {
  if (!DATA || !DATA.keys.length) return legacyLease();

  const t = nowMs();
  const list = DATA.keys.filter((k) => eligible(k, t, opts.exclude));
  if (!list.length) return null;

  let chosen;
  if (rotationMode() === 'least_used') {
    chosen = list.reduce((best, k) => {
      const a = best.stats.ok + best.stats.fail;
      const b = k.stats.ok + k.stats.fail;
      return b < a ? k : best;
    });
  } else {
    // 从游标往后找第一把可用 Key：被跳过的（冷却/限流/停用）不会一直压住队首
    const start = ((Number(DATA.cursor) || 0) % DATA.keys.length + DATA.keys.length) % DATA.keys.length;
    chosen = list[0];
    for (let i = 0; i < DATA.keys.length; i++) {
      const cand = DATA.keys[(start + i) % DATA.keys.length];
      if (list.includes(cand)) {
        chosen = cand;
        DATA.cursor = (start + i + 1) % DATA.keys.length;
        break;
      }
    }
  }

  markUse(chosen);
  return { id: chosen.id, key: chosen.key, label: chosen.label, rpm: chosen.rpm };
}

/** 池子里到底有没有可用的 Key（不占 RPM 名额） */
function hasAny() {
  if (!DATA || !DATA.keys.length) return !!String(store.getRawKey() || '').trim();
  const t = nowMs();
  return DATA.keys.some((k) => k.enabled && cooldownLeftMs(k, t) === 0);
}

/**
 * 看一眼当前可用的明文 Key，不记账、不推进游标。
 * 只给「下载视频」这种不走 Agnes 计量、但需要带鉴权头的场景用；
 * 正经的 API 调用请走 pick()，否则 RPM 限流就是假的。
 */
function peek() {
  if (!DATA || !DATA.keys.length) return String(store.getRawKey() || '').trim();
  const t = nowMs();
  const entry = DATA.keys.find((k) => k.enabled && cooldownLeftMs(k, t) === 0 && rpmLeft(k, t) > 0)
    || DATA.keys.find((k) => k.enabled);
  return entry ? entry.key : '';
}

/**
 * 一把都取不到时，说清楚为什么、还要等多久。
 * 只说「没有可用密钥」的话，用户分不清是没配、全停了、还是全在限流。
 */
function exhaustedInfo() {
  const total = DATA ? DATA.keys.length : 0;
  if (!total) {
    return {
      errorType: 'no_api_key',
      message: '请先在「设置 → 密钥池」添加 Agnes API Key。',
      retryAfterMs: 0,
    };
  }

  const t = nowMs();
  const enabled = DATA ? DATA.keys.filter((k) => k.enabled) : [];
  if (!enabled.length) {
    return {
      errorType: 'keys_disabled',
      message: `密钥池里 ${total} 把 Key 全部处于停用状态，请到「设置 → 密钥池」启用或新增。`,
      retryAfterMs: 0,
    };
  }

  const waits = enabled.map((k) => {
    const cd = cooldownLeftMs(k, t);
    const arr = pruneWindow(k.id, t);
    const rateWait = k.rpm > 0 && arr.length >= k.rpm
      ? Math.max(0, WINDOW_MS - (t - arr[0]))
      : 0;
    return Math.max(cd, rateWait);
  }).filter((n) => n > 0);

  const waitMs = waits.length ? Math.min(...waits) : 0;
  const secs = Math.ceil(waitMs / 1000);
  return {
    errorType: 'keys_exhausted',
    message: secs
      ? `密钥池暂时没有可用 Key（限流或冷却中），约 ${secs} 秒后恢复；也可以调高单 Key 的 RPM 或再加一把 Key。`
      : '密钥池暂时没有可用 Key，请检查 Key 状态。',
    retryAfterMs: waitMs,
  };
}

// ── 反馈结果 ─────────────────────────────────────────────────
/**
 * 一次请求结束后回报结果。
 * @param {string} id
 * @param {{ok:boolean, fault?:boolean, status?:number, errorType?:string, message?:string}} r
 *   fault=true 表示「这把 Key 本身有问题」（401/402/403/429），换一把大概率能过；
 *   普通失败（参数错、内容审核、超时）不冷却，否则会把好 Key 一起冻住。
 */
function report(id, r = {}) {
  if (!DATA || id === LEGACY_ID) return;
  const entry = DATA.keys.find((k) => k.id === id);
  if (!entry) return;
  const st = entry.stats;

  if (r.ok) {
    st.ok += 1;
    st.last_used_at = nowIso();
    st.last_error = '';
    entry.auth_failures = 0;
    schedulePersist();
    return;
  }

  st.fail += 1;
  st.last_used_at = nowIso();
  if (r.message) st.last_error = String(r.message).slice(0, 300);

  if (r.fault) {
    const status = Number(r.status) || 0;
    if (status === 401 || status === 403 || r.errorType === 'invalid_api_key') {
      entry.auth_failures += 1;
      entry.cooldown_until = nowMs() + 10 * 60 * 1000;
      if (entry.auth_failures >= AUTH_FAIL_LIMIT) {
        entry.enabled = false;
        entry.auto_disabled = true;
        entry.stats.last_error = `连续 ${AUTH_FAIL_LIMIT} 次认证失败，已自动停用`;
      }
    } else if (status === 402) {
      // 余额/额度类：短时间重试没有意义
      entry.cooldown_until = nowMs() + 30 * 60 * 1000;
      entry.auth_failures = 0;
    } else if (status === 429) {
      entry.cooldown_until = nowMs() + cooldownBase() * 1000;
      entry.auth_failures = 0;
    } else {
      entry.auth_failures = 0;
    }
  }
  schedulePersist();
}

// ── 增删改查 ─────────────────────────────────────────────────
function statusOf(entry, t = nowMs()) {
  if (!entry.enabled) return 'disabled';
  if (cooldownLeftMs(entry, t) > 0) return 'cooling';
  if (rpmLeft(entry, t) <= 0) return 'rate_limited';
  return 'active';
}

/** 对外只给掩码，任何接口都拿不到明文 */
function toMasked(entry) {
  const t = nowMs();
  return {
    id: entry.id,
    label: entry.label,
    masked: store.maskKey(entry.key),
    enabled: entry.enabled,
    auto_disabled: !!entry.auto_disabled,
    rpm: entry.rpm,
    created_at: entry.created_at,
    status: statusOf(entry, t),
    cooldown_left_seconds: Math.ceil(cooldownLeftMs(entry, t) / 1000),
    used_in_window: usedInWindow(entry.id),
    stats: {
      ok: entry.stats.ok,
      fail: entry.stats.fail,
      last_used_at: entry.stats.last_used_at,
      last_error: entry.stats.last_error,
    },
  };
}

function list() {
  if (!DATA) return [];
  return DATA.keys.map(toMasked);
}

function summary() {
  const rows = list();
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    cooling: rows.filter((r) => r.status === 'cooling').length,
    rate_limited: rows.filter((r) => r.status === 'rate_limited').length,
    disabled: rows.filter((r) => r.status === 'disabled').length,
    mode: rotationMode(),
    default_rpm: defaultRpm(),
    max: maxKeys(),
    // 池子空但旧单 Key 还在：界面要能提示用户「还能跑，但只有一把」
    legacy: !rows.length && !!String(store.getRawKey() || '').trim(),
    migrated: !!(DATA && DATA.migrated),
  };
}

function find(id) {
  return DATA ? DATA.keys.find((k) => k.id === id) || null : null;
}

function add({ label, key, rpm } = {}) {
  if (!DATA) return { ok: false, error: '密钥池尚未初始化' };
  const cleaned = cleanKey(key);
  if (!looksLikeKey(cleaned)) return { ok: false, error: 'Key 看起来不完整（至少 8 个字符且不含空格）' };
  if (DATA.keys.length >= maxKeys()) return { ok: false, error: `最多 ${maxKeys()} 把 Key，可在设置里调高上限` };
  if (DATA.keys.some((k) => k.key === cleaned)) return { ok: false, error: '这把 Key 已经在密钥池里了', duplicate: true };

  const entry = normalizeEntry({
    label: String(label || '').trim() || `密钥 ${DATA.keys.length + 1}`,
    key: cleaned,
    rpm: clampInt(rpm, 1, 600, defaultRpm()),
    enabled: true,
  });
  DATA.keys.push(entry);
  persistNow();
  return { ok: true, key: toMasked(entry) };
}

/**
 * 批量粘贴导入。一行一把，支持三种写法：
 *    sk-xxxx
 *    备用号,sk-xxxx
 *    备用号 sk-xxxx
 */
function addMany(text, { rpm } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const added = [];
  const skipped = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[,，\t]+|\s+/).filter(Boolean);
    let label = '';
    let key = '';
    if (parts.length >= 2 && looksLikeKey(parts[parts.length - 1])) {
      key = parts[parts.length - 1];
      label = parts.slice(0, -1).join(' ');
    } else {
      key = parts[0] || '';
    }
    const r = add({ label, key, rpm });
    if (r.ok) added.push(r.key);
    else skipped.push({ line, reason: r.error });
  }
  return { ok: true, added, skipped };
}

function update(id, patch = {}) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '密钥不存在' };

  if ('label' in patch) entry.label = String(patch.label || '').slice(0, 40) || entry.label;
  if ('rpm' in patch) entry.rpm = clampInt(patch.rpm, 1, 600, entry.rpm);
  if ('enabled' in patch) {
    entry.enabled = patch.enabled !== false && patch.enabled !== '0' && patch.enabled !== 0;
    // 手动重新启用等于认可这把 Key，把自动停用的标记和失败计数清掉
    if (entry.enabled) {
      entry.auto_disabled = false;
      entry.auth_failures = 0;
      entry.cooldown_until = 0;
    }
  }
  if ('key' in patch && String(patch.key || '').trim()) {
    const cleaned = cleanKey(patch.key);
    if (!looksLikeKey(cleaned)) return { ok: false, error: 'Key 看起来不完整（至少 8 个字符且不含空格）' };
    if (DATA.keys.some((k) => k.id !== id && k.key === cleaned)) return { ok: false, error: '这把 Key 已经在密钥池里了', duplicate: true };
    entry.key = cleaned;
    entry.auth_failures = 0;
    entry.cooldown_until = 0;
    entry.stats.last_error = '';
  }
  persistNow();
  return { ok: true, key: toMasked(entry) };
}

function remove(id) {
  if (!DATA) return { ok: false, error: '密钥池尚未初始化' };
  const before = DATA.keys.length;
  DATA.keys = DATA.keys.filter((k) => k.id !== id);
  if (DATA.keys.length === before) return { ok: false, error: '密钥不存在' };
  windows.delete(id);
  if (DATA.cursor >= DATA.keys.length) DATA.cursor = 0;
  persistNow();
  return { ok: true, total: DATA.keys.length };
}

/** 解除冷却 / 重新启用，用于「刚充了额度」「误判被冻住」这类场景 */
function revive(id) {
  const entry = find(id);
  if (!entry) return { ok: false, error: '密钥不存在' };
  entry.cooldown_until = 0;
  entry.auth_failures = 0;
  entry.enabled = true;
  entry.auto_disabled = false;
  entry.stats.last_error = '';
  windows.delete(id);
  persistNow();
  return { ok: true, key: toMasked(entry) };
}

function reviveAll() {
  if (!DATA) return { ok: false, error: '密钥池尚未初始化' };
  for (const entry of DATA.keys) {
    entry.cooldown_until = 0;
    entry.auth_failures = 0;
    windows.delete(entry.id);
  }
  persistNow();
  return { ok: true, keys: list() };
}

/** 单把 Key 的明文，只给「测试这把 Key」用，绝不进任何 HTTP 响应 */
function rawKey(id) {
  const entry = find(id);
  return entry ? entry.key : '';
}

module.exports = {
  init, _resetForTest, ready,
  pick, hasAny, peek, exhaustedInfo, report,
  list, summary, add, addMany, update, remove, revive, reviveAll, rawKey,
  toMasked, statusOf, cleanKey, looksLikeKey,
  LEGACY_ID, DEFAULT_MAX_KEYS, maxKeys, WINDOW_MS,
};
