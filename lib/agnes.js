/**
 * agnes.js — Agnes API 客户端
 * ------------------------------------------------------------------
 * 原版要绕一层 Supabase Edge Function 才能调 Agnes（因为浏览器有跨域、
 * 且 API Key 不能落前端）。本地版把这一层收进本机服务：
 *   · API Key 只存在本机 settings.json，前端永远拿不到明文
 *   · 没有 Edge Function 的 90s/150s 双层超时，改成直连，超时自己定
 *   · 原版的链路诊断（request_sent / response_received / response_status）
 *     保留下来 —— 排查「到底 Agnes 收没收到请求」时这几个字段最值钱
 *
 * 接口规则（照搬原版验证过的结论）：
 *   text         POST {base}/v1/chat/completions
 *   image        POST {base}/v1/images/generations   图生图 body.image=[url]
 *   video_create POST {base}/v1/videos               image 直接放顶层
 *   video_query  GET  {rootBase}/agnesapi?video_id=  （rootBase = 去掉 /v1）
 */
'use strict';

const store = require('./store');
const keys = require('./keys');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── URL 归一化 ───────────────────────────────────────────────
function normalizeBase(raw) {
  let base = String(raw || 'https://apihub.agnes-ai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}
/** 去掉结尾 /v1，查询接口用的是域名根路径 */
function rootBase(base) {
  return normalizeBase(base).replace(/\/v1$/, '');
}
function withV1(base) {
  const b = normalizeBase(base);
  return b.endsWith('/v1') ? b : `${b}/v1`;
}

// ── 错误 ─────────────────────────────────────────────────────
class AgnesError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AgnesError';
    this.errorType = opts.errorType || 'agnes_error';
    this.status = opts.status || 0;
    this.responseData = opts.responseData || null;
    this.diagnostics = opts.diagnostics || null;
  }
}

/**
 * 密钥池一把都用不了时的错误。
 * 必须区分「没配」「全停用」「全在限流/冷却」—— 三种情况的处理方式完全不同，
 * 统一报「没有可用 Key」用户只能瞎猜。
 */
function exhaustedError() {
  const info = keys.exhaustedInfo();
  return new AgnesError(info.message, {
    errorType: info.errorType,
    status: 0,
    responseData: null,
    diagnostics: { request_sent: false, response_received: false, response_status: null, retry_after_ms: info.retryAfterMs },
  });
}

/** 哪些失败该换一把 Key 再试：认证、额度、限流 */
const KEY_FAULT_STATUS = new Set([401, 402, 403, 429]);

function isKeyFault(e) {
  if (!(e instanceof AgnesError)) return false;
  if (KEY_FAULT_STATUS.has(Number(e.status))) return true;
  if (e.errorType === 'invalid_api_key') return true;
  return /invalid.?api.?key|quota|insufficient|balance|余额|额度|rate.?limit|too many requests/i
    .test(String(e.message || ''));
}

function maxKeyAttempts() {
  const n = Number(store.getSettings().key_max_attempts);
  return Math.min(10, Math.max(1, Math.round(n) || 3));
}

/**
 * 带轮换的执行器：每次向密钥池要一把 Key，失败且判定为「Key 的问题」时换下一把。
 *
 * 注意两点：
 *   1. 超时**不换 Key**（createVideo 内部会把它转成 timed_out 返回）——
 *      请求可能已经送达，换 Key 重发就是重复扣费。
 *   2. tried 记录本次已试过的 Key，避免同一把被重复选中（least_used 模式下很容易）。
 */
async function callWithRotation(fn) {
  const tried = new Set();
  const limit = maxKeyAttempts();
  let lastErr = null;

  for (let i = 0; i < limit; i++) {
    const lease = keys.pick({ exclude: tried });
    if (!lease) break;
    tried.add(lease.id);
    try {
      const out = await fn(lease.key, lease);
      keys.report(lease.id, { ok: true });
      return out;
    } catch (e) {
      if (isKeyFault(e)) {
        keys.report(lease.id, {
          ok: false, fault: true, status: e.status, errorType: e.errorType, message: e.message,
        });
        lastErr = e;
        continue;
      }
      keys.report(lease.id, { ok: false, fault: false, message: e.message });
      throw e;
    }
  }

  if (!tried.size) throw exhaustedError();
  throw lastErr;
}

/**
 * 统一发起请求。
 * @returns {Promise<{data:object, diagnostics:object}>}
 */
async function request(url, { method = 'POST', body, timeoutMs = 25000, apiKey }) {
  const startedAt = Date.now();
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) options.body = JSON.stringify(body);

  let resp;
  let text;
  try {
    resp = await fetch(url, options);
    text = await resp.text();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const isTimeout = /timed out|abort/i.test(msg);
    const err = new AgnesError(
      isTimeout ? `请求 Agnes 超时（${Math.round(timeoutMs / 1000)}s 未返回）` : `网络异常：${msg}`,
      {
        errorType: isTimeout ? 'proxy_timeout' : 'network_error',
        status: 0,
        responseData: null,
        diagnostics: {
          request_sent: true,
          response_received: false,
          response_status: null,
          duration_ms: Date.now() - startedAt,
          timed_out: isTimeout,
        },
      },
    );
    throw err;
  }

  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }

  const diagnostics = {
    request_sent: true,
    response_received: true,
    response_status: resp.status,
    duration_ms: Date.now() - startedAt,
    final_request_url: url,
  };

  if (!resp.ok) {
    const msg = String((data && (data.error?.message || data.error || data.message)) || `Agnes 返回 HTTP ${resp.status}`);
    throw new AgnesError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
      errorType: data?.error?.type === 'invalid_api_key' || resp.status === 401 ? 'invalid_api_key' : 'agnes_error',
      status: resp.status,
      responseData: data,
      diagnostics,
    });
  }

  return { data, diagnostics };
}

// ── 文本 ─────────────────────────────────────────────────────
async function chat(messages, { model, temperature = 0.7, timeoutMs = 120000 } = {}) {
  const s = store.getSettings();
  const url = `${withV1(s.agnes_api_base_url)}/chat/completions`;
  const out = await callWithRotation(async (apiKey) => {
    const { data, diagnostics } = await request(url, {
      method: 'POST',
      body: { model: model || s.default_text_model, messages, temperature },
      timeoutMs,
      apiKey,
    });
    return { content: data?.choices?.[0]?.message?.content || '', data, diagnostics };
  });
  return { content: out.content, raw: out.data, diagnostics: out.diagnostics };
}

// ── 图片 ─────────────────────────────────────────────────────
/**
 * 生成图片。Agnes 走 LiteLLM 代理，不认 response_format，
 * 实际返回 b64_json 居多 —— 由调用方落盘成本地文件。
 * @returns {{url?:string, b64?:string, mime:string, raw:object, diagnostics:object}}
 */
async function image({ prompt, model, size = '1024x1024', image: inputImage, timeoutMs = 120000 }) {
  const s = store.getSettings();
  const url = `${withV1(s.agnes_api_base_url)}/images/generations`;
  const body = { model: model || s.default_image_model, prompt, size };
  if (inputImage) body.image = Array.isArray(inputImage) ? inputImage : [inputImage];

  const out = await callWithRotation(async (apiKey) => {
    const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey });
    return { item: data?.data?.[0] || {}, data, diagnostics };
  });
  return {
    url: out.item.url || '',
    b64: out.item.b64_json || '',
    mime: 'image/png',
    raw: out.data,
    diagnostics: out.diagnostics,
  };
}

// ── 视频创建 ─────────────────────────────────────────────────
/**
 * Video 2.5 与 2.0 的请求体不是一回事：
 *   2.5 认 mode / seconds / size / images[] / audios[] / videos[] / first_frame，
 *       而且 width / height / fps / num_frames 传了直接 400；
 *   2.0 认 width / height / num_frames / frame_rate / image。
 * 模型目录是动态拉的，用户选到 2.5 时如果还按 2.0 发，每个请求都会被 400 打回，
 * 界面上只看得到「提交失败」，很难想到是模型换了契约。所以按模型族分流。
 */
function isVideo25(model) {
  const m = String(model || '').toLowerCase();
  return /2[._-]?5/.test(m);
}

/** Video 2.5 的素材上限（官方文档）。超了会 400，不如在提交前拦住并说清楚。 */
const MEDIA_LIMITS_25 = { images: 8, audios: 3, videos: 1, total: 12 };

/**
 * 2.5 的时长是字符串 "4"~"12"。前端给的是秒数，这里夹到合法区间。
 * 不夹的话用户选 3 秒会被 400，而界面上只会显示「提交失败」。
 */
function secondsFor25(v) {
  const n = Math.round(Number(v) || 5);
  return String(Math.min(12, Math.max(4, n)));
}

/** 提交视频任务。只要拿到 video_id / task_id 就算提交成功，不等生成完成。
 *  图生视频时 Agnes 要先从公网抓参考素材，可能很久 —— 超时按 150s 起。 */
/**
 * 按模型族拼请求体。抽成纯函数是为了能单独测——
 * 「2.5 不能带 num_frames」这种契约错误，靠跑一次真实提交才发现就太晚了。
 */
function buildVideoBody(params, model) {
  const body = { model, prompt: params.prompt };
  if (params.seed != null && params.seed !== '') body.seed = Number(params.seed);

  if (isVideo25(model)) {
    // ── Video 2.5 契约 ──
    body.mode = params.mode_25 || 'text';
    body.seconds = secondsFor25(params.duration_seconds);
    if (params.size_25) body.size = params.size_25;
    if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;

    if (params.source_images && params.source_images.length) {
      const refs = params.source_images
        .map((i) => (i && typeof i === 'object'
          ? { url: String(i.url || ''), role: String(i.role || '') }
          : { url: String(i || ''), role: '' }))
        .filter((r) => r.url);
      if (body.mode === 'keyframe') {
        /**
         * 2.5 的首尾帧只按位置取 first/last，role 完全不看。
         * 调用方一旦把「中间帧」插在第二位，真正的结束帧就被挤到 images[] 里，
         * 生成的过渡动画终点就错了。所以这里按 role 认，认不出来再退回位置顺序。
         */
        const byRole = (re) => refs.find((r) => re.test(r.role));
        const first = byRole(/起始|首帧|start|first/i) || refs[0];
        const last = byRole(/目标|结束|尾帧|end|last/i) || refs.find((r) => r !== first);
        if (first) body.first_frame = first.url;
        if (last) body.last_frame = last.url;
        for (const r of refs) {
          if (r === first || r === last) continue;
          (body.images ||= []).push(r.url);
        }
      } else {
        body.images = refs.map((r) => r.url);
      }
    } else if (params.image) {
      if (body.mode === 'keyframe') body.first_frame = params.image;
      else body.images = [params.image];
    }

    // 音频参考：Agnes 2.5 的「音频生视频」走的就是这个字段，
    // 提示词里用 <Audio 1> 指代第 1 段。上限 3 段、总时长 2~12 秒。
    if (params.audios && params.audios.length) {
      body.audios = params.audios.filter(Boolean).slice(0, 3);
      if (body.mode === 'text') body.mode = 'reference';
    }
    if (params.videos_25 && params.videos_25.length) body.videos = params.videos_25;
  } else {
    // ── Video 2.0 及未知模型：保持原有契约 ──
    body.width = params.width || 1152;
    body.height = params.height || 768;
    body.num_frames = params.num_frames || 121;
    body.frame_rate = params.frame_rate || 24;
    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
    if (params.source_images && params.source_images.length) {
      // 多图参考 / 关键帧：image 是 URL 数组，直接放顶层（不能包 extra_body）
      body.image = params.source_images.map((i) => i.url || i);
      if (params.mode_flag === 'keyframes') body.mode = 'keyframes';
    } else if (params.image) {
      body.image = params.image;
    }
    if (params.audios && params.audios.length) {
      body.audios = params.audios.filter(Boolean).slice(0, 3);
    }
  }

  /**
   * 额外参数通道：Agnes 以后新增能力（如音频驱动、新的控制字段）时，
   * 用户直接在界面上填 JSON 就能用上，不用等程序改代码。
   * 已有的核心参数不允许被覆盖，避免把 prompt / model 这类字段顶掉。
   */
  if (params.extra_params && typeof params.extra_params === 'object') {
    for (const [k, v] of Object.entries(params.extra_params)) {
      if (k in body) continue;
      body[k] = v;
    }
  }
  return body;
}

async function createVideo(params) {
  const s = store.getSettings();

  const model = params.model || s.default_video_model;
  const body = buildVideoBody(params, model);

  const url = `${withV1(s.agnes_api_base_url)}/videos`;
  const timeoutMs = Number(s.request_timeout_ms) || 150000;

  const attempt = async (apiKey) => {
    try {
      const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey });
      if (data?.error && !data?.video_id && !data?.id) {
        throw new AgnesError(String(data.error?.message || data.error), {
          errorType: 'agnes_error', status: 200, responseData: data, diagnostics,
        });
      }
      const video_id = data?.video_id || data?.id || '';
      if (!video_id) {
        throw new AgnesError('Agnes 未返回 video_id（响应体中无 video_id / id 字段）', {
          errorType: 'no_video_id', status: 200, responseData: data, diagnostics,
        });
      }
      return { video_id, task_id: data?.task_id || '', raw: data, diagnostics, timed_out: false };
    } catch (e) {
      // 超时但请求已发出：Agnes 可能已经收下任务了。不能当失败丢掉 ——
      // 原版为此专门做了「提交超时未知」状态，让用户去 Agnes 账单核对后再补录 video_id。
      if (e instanceof AgnesError && e.errorType === 'proxy_timeout') {
        return {
          video_id: '',
          task_id: '',
          raw: e.responseData || {},
          diagnostics: e.diagnostics,
          timed_out: true,
          message: e.message,
        };
      }
      throw e;
    }
  };

  /**
   * 只有「明确的 5xx 服务端错误」才在同一把 Key 上重试。
   * 429 / 401 / 402 / 403 交给外层轮换换 Key —— 同一把 Key 立刻重发只会再被拒一次。
   * 超时一律不重试：那种情况下 Agnes 多半已经收下任务，再发一次就是重复扣费。
   *
   * Flash 的「队列已满」是 503 video_queue_full：换 Key 没用（队列是全局的），
   * 只能等。所以给它单独放宽重试次数和退避时间，并把错误类型标成 queue_full，
   * 让界面能说清「不是 Key 坏了，是排队」。
   */
  const isFlash = isVideo25(model) && /flash/i.test(model);
  return callWithRotation(async (apiKey) => {
    let lastErr = null;
    const rounds = isFlash ? 6 : 3;
    for (let i = 0; i < rounds; i++) {
      if (i > 0) await sleep(isFlash ? Math.min(15000, 3000 * i) : 4000 * i);
      try {
        return await attempt(apiKey);
      } catch (e) {
        const retryable = e instanceof AgnesError && e.status >= 500;
        if (!retryable) throw e;
        lastErr = e;
      }
    }
    if (lastErr && /queue is full|video_queue_full/i.test(String(lastErr.message || ''))) {
      lastErr.errorType = 'queue_full';
    }
    throw lastErr;
  });
}

// ── 视频查询 ─────────────────────────────────────────────────
/**
 * 查询 URL。
 * 2.5 的 reference / keyframe 任务**必须**带 model_name，
 * 不带只会返回 `task not found`（看起来像任务丢了，其实是缺参数）。
 * text 模式虽然可以不带，但统一带上没有副作用，也省得按 mode 分支。
 */
function videoQueryUrl(videoId, model) {
  const s = store.getSettings();
  const base = `${rootBase(s.agnes_api_base_url)}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
  const m = String(model || '').trim();
  return m && isVideo25(m) ? `${base}&model_name=${encodeURIComponent(m)}` : base;
}

async function queryVideo(videoId, { model } = {}) {
  const url = videoQueryUrl(videoId, model);
  return callWithRotation(async (apiKey) => {
    const { data, diagnostics } = await request(url, { method: 'GET', timeoutMs: 25000, apiKey });
    return { data, diagnostics };
  });
}

/** Agnes v2.0 把最终视频地址放在 remixed_from_video_id 里，命名怪但确实如此 */
function extractVideoUrl(result) {
  return result?.remixed_from_video_id || result?.video_url || result?.output_url || result?.url || '';
}

/**
 * 状态机保护：由 Agnes 查询结果生成安全的更新字段。
 * 规则（原版踩坑总结）：
 *   1. 只有 Agnes 明确 status=failed 才标远端失败
 *   2. completed 但没 video_url → video_url_missing，不是 failed
 *   3. 未知 status → 不动状态，只存原始响应
 */
function buildSafeStatusUpdate(result) {
  const updates = { raw_status_response: result };
  const agnesStatus = result?.status;
  const videoUrl = extractVideoUrl(result);
  const progress = result?.progress;

  if (videoUrl) updates.video_url = videoUrl;
  if (result?.error) updates.error_message = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  if (progress != null) updates.progress = Number(progress) || 0;

  if (agnesStatus === 'failed') {
    updates.status = 'failed';
    updates.remote_status = 'failed';
  } else if (agnesStatus === 'completed') {
    updates.completed_at = new Date().toISOString();
    updates.remote_status = 'completed';
    if (videoUrl) {
      updates.status = 'completed';
      updates.local_status = 'completed';
    } else {
      updates.status = 'video_url_missing';
      updates.local_status = 'result_parse_failed';
    }
  } else if (agnesStatus === 'in_progress') {
    updates.status = 'in_progress';
    updates.remote_status = 'in_progress';
    updates.local_status = 'polling';
  } else if (agnesStatus === 'queued') {
    updates.status = 'queued';
    updates.remote_status = 'queued';
    updates.local_status = 'polling';
  }
  return updates;
}

// ── 视频下载 ─────────────────────────────────────────────────
async function downloadVideo(videoUrl, destFile) {
  // 下载走 CDN，不算 Agnes 的 API 调用，所以不占用密钥池的 RPM 名额
  const key = keys.peek();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const resp = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(300000) });
  if (!resp.ok) throw new AgnesError(`视频下载失败：HTTP ${resp.status}`, { errorType: 'download_failed', status: resp.status });
  const buf = Buffer.from(await resp.arrayBuffer());
  require('node:fs').writeFileSync(destFile, buf);
  return { file: destFile, bytes: buf.length };
}

// ── 动态模型目录 ─────────────────────────────────────────────
/**
 * 读取 OpenAI 兼容的 GET /v1/models。
 * 兼容 Agnes 可能返回的三种形状：
 *   { data: [{ id: ... }] } / { models: [...] } / [...]。
 * 模型目录是可选能力：接口不存在或临时失败时，不影响已有模型和生成流程。
 */
async function listModels({ timeoutMs = 30000 } = {}) {
  const s = store.getSettings();
  const url = `${withV1(s.agnes_api_base_url)}/models`;
  return callWithRotation(async (apiKey) => {
    const { data, diagnostics } = await request(url, { method: 'GET', timeoutMs, apiKey });
    return { data, diagnostics };
  });
}

// ── 连通性测试 ───────────────────────────────────────────────
/**
 * @param {'text'|'image'|'video'} kind
 * @param {{keyId?:string}} opts 指定 keyId 时只测那一把（密钥池页面用），
 *                              不指定则走轮换，测的是「池子里随便一把能不能通」
 */
async function testConnection(kind = 'text', opts = {}) {
  const s = store.getSettings();
  const keyId = opts.keyId || '';

  const run = async (apiKey) => {
    if (kind === 'text') {
      const url = `${withV1(s.agnes_api_base_url)}/chat/completions`;
      const { data } = await request(url, {
        method: 'POST',
        body: {
          model: s.default_text_model,
          messages: [{ role: 'user', content: '回复两个字：正常' }],
          temperature: 0,
        },
        timeoutMs: 30000,
        apiKey,
      });
      const content = data?.choices?.[0]?.message?.content || '';
      return { ok: true, message: content.slice(0, 60) || '已连通（返回为空）' };
    }
    if (kind === 'image') {
      const url = `${withV1(s.agnes_api_base_url)}/images/generations`;
      await request(url, { method: 'POST', body: { model: s.default_image_model, prompt: 'test', size: '1024x1024' }, timeoutMs: 30000, apiKey });
      return { ok: true, message: '图片接口可达' };
    }
    const url = `${withV1(s.agnes_api_base_url)}/videos`;
    try {
      await request(url, { method: 'POST', body: { model: s.default_video_model, prompt: 'test' }, timeoutMs: 20000, apiKey });
      return { ok: true, message: '视频接口可达' };
    } catch (e) {
      // 视频接口即使参数不全，只要不是 401/404 也算可达
      if (e.status === 401) throw e;
      return { ok: true, message: `视频接口可达（返回 ${e.status || '超时'}）` };
    }
  };

  if (keyId) {
    const raw = keys.rawKey(keyId);
    if (!raw) throw new AgnesError('这把 Key 已经不在密钥池里了', { errorType: 'no_api_key', status: 0 });
    try {
      const out = await run(raw);
      keys.report(keyId, { ok: true });
      return out;
    } catch (e) {
      keys.report(keyId, {
        ok: false, fault: isKeyFault(e), status: e.status, errorType: e.errorType, message: e.message,
      });
      throw e;
    }
  }

  return callWithRotation(run);
}

module.exports = {
  normalizeBase, rootBase, withV1,
  AgnesError,
  chat, image, createVideo, buildVideoBody, queryVideo, videoQueryUrl, downloadVideo, listModels,
  extractVideoUrl, buildSafeStatusUpdate,
  isVideo25, secondsFor25, MEDIA_LIMITS_25,
  testConnection,
  callWithRotation, isKeyFault, exhaustedError, maxKeyAttempts,
};
