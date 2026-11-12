/**
 * prompts/index.js — 提示词目录
 * ------------------------------------------------------------------
 * 这里只做三件事：汇总、排序、校验。具体文案在各自的阶段文件里。
 *
 * 目录结构（按生产阶段，而不是按 UI 顺序）：
 *   script.js      构思 → 梗概 → 分集 → 单集
 *   storyboard.js  资产提取 → 分镜表
 *   media.js       图片提示词 → 视频提示词
 *   optimize.js    8 个单点改造
 *
 * 每个模板都必须带：stage / order / version / variables / output_contract。
 * 前四个用于排序与迁移，后两个既是文档，也是测试的断言依据。
 */
'use strict';

const script = require('./script');
const storyboard = require('./storyboard');
const media = require('./media');
const optimize = require('./optimize');

/** 提示词库版本：改文案或改契约都要 +1，seed 迁移据此判断是否需要覆盖 */
const PROMPT_VERSION = '2.0.0';

const STAGE_ORDER = { script: 1, storyboard: 2, media: 3, optimize: 4 };
const TEMPLATE_TYPES = ['story_concept', 'plot_summary', 'episode_outline', 'episode_script', 'storyboard_script', 'asset_extract', 'image_prompt', 'video_prompt', 'optimize'];

/** 分镜表必须覆盖的字段：少一个，routes.storyboardRow() 就会静默丢数据 */
const REQUIRED_STORYBOARD_FIELDS = [
  'shot_number', 'shot_type', 'scene_description', 'characters', 'scene', 'action',
  'dialogue', 'narration', 'sound_effect', 'duration_seconds', 'image_prompt', 'video_prompt', 'negative_prompt',
];

const DEFAULT_TEMPLATES = [...script, ...storyboard, ...media, ...optimize]
  .sort((a, b) => (STAGE_ORDER[a.stage] || 99) - (STAGE_ORDER[b.stage] || 99) || (a.order || 0) - (b.order || 0));

/**
 * 静态校验：变量声明与正文是否一致、契约是否完整、字段是否对齐。
 * 这些错误不会让程序崩溃，但会让模型「少给一个字段」或「变量永远填不进去」，
 * 属于必须在上线前拦住的那类问题。
 * @returns {string[]} 错误列表，空数组表示通过
 */
function validateTemplates(list = DEFAULT_TEMPLATES) {
  const errors = [];
  const seen = new Set();

  for (const t of list) {
    const tag = t && t.key ? t.key : '(未命名模板)';
    if (!t || typeof t !== 'object') { errors.push(`${tag}: 不是对象`); continue; }
    if (!t.key) errors.push(`${tag}: 缺少 key`);
    if (seen.has(t.key)) errors.push(`${tag}: key 重复`);
    seen.add(t.key);
    if (!t.name) errors.push(`${tag}: 缺少 name`);
    if (!TEMPLATE_TYPES.includes(t.template_type)) errors.push(`${tag}: template_type 非法（${t.template_type}）`);
    if (!STAGE_ORDER[t.stage]) errors.push(`${tag}: stage 非法（${t.stage}）`);
    if (!Number.isFinite(t.order)) errors.push(`${tag}: order 必须是数字`);
    if (!Number.isFinite(t.version)) errors.push(`${tag}: version 必须是数字`);
    if (!t.system || t.system.length < 10) errors.push(`${tag}: system 太短`);
    if (!t.content || t.content.length < 120) errors.push(`${tag}: content 太短`);

    const used = [...String(t.content || '').matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
    const declared = (t.variables || []).map((v) => v.name);
    for (const v of used) if (!declared.includes(v)) errors.push(`${tag}: 正文用了未声明的变量 {{${v}}}`);
    for (const v of declared) if (!used.includes(v)) errors.push(`${tag}: 声明了变量 {{${v}}} 但正文没用到`);
    // 同一个变量在正文里出现多次是正常的（比如 {{时长}} 在说明里再提一次），
    // fillTemplate 会全部替换；真正要防的是 variables 里重复声明。
    if (new Set(declared).size !== declared.length) errors.push(`${tag}: variables 里重复声明了同一个变量`);

    const contract = t.output_contract;
    if (!contract || !['json_object', 'json_array', 'text'].includes(contract.type)) {
      errors.push(`${tag}: output_contract.type 非法`);
    } else if (contract.type !== 'text' && !(Array.isArray(contract.fields) && contract.fields.length)) {
      errors.push(`${tag}: JSON 契约必须声明 fields`);
    }

    if (t.key === 'storyboard_script') {
      const missing = REQUIRED_STORYBOARD_FIELDS.filter((f) => !(contract.fields || []).includes(f));
      if (missing.length) errors.push(`${tag}: 分镜契约缺字段 ${missing.join(', ')}`);
    }
  }

  return errors;
}

/** 按 key 取模板（seed 与测试共用） */
function getTemplate(key) {
  return DEFAULT_TEMPLATES.find((t) => t.key === key) || null;
}

module.exports = {
  PROMPT_VERSION,
  DEFAULT_TEMPLATES,
  TEMPLATE_TYPES,
  REQUIRED_STORYBOARD_FIELDS,
  STAGE_ORDER,
  validateTemplates,
  getTemplate,
};
