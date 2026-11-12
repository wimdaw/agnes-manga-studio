/**
 * seed.js — 内置提示词模板的写入与升级
 * ------------------------------------------------------------------
 * v1 的问题：只有「缺 key 才插入」，所以内置模板一旦写进库就再也不会更新，
 * 改提示词等于只对新用户生效 —— 老用户永远停在旧版本。
 *
 * v2 的做法：
 *   · 模板库带 PROMPT_VERSION，库里记 prompt_seed_version
 *   · 版本变化时，只升级「内置且用户没改过」的模板
 *   · 用户改过的（is_customized）和用户自建的（is_builtin=false）一律不动
 *   · 升级是幂等的：同版本重复启动不会再写盘
 */
'use strict';

const { DEFAULT_TEMPLATES, PROMPT_VERSION, validateTemplates } = require('./prompts');

/** 会被写入/升级的字段。id、created_at、is_favorited 等保持原样 */
const SYNC_FIELDS = [
  'name', 'template_type', 'stage', 'order', 'version',
  'system', 'content', 'negative_prompt', 'notes',
  'variables', 'output_contract', 'seed_version',
];

function payloadOf(tpl) {
  return {
    key: tpl.key,
    name: tpl.name,
    template_type: tpl.template_type,
    stage: tpl.stage,
    order: tpl.order,
    version: tpl.version,
    system: tpl.system,
    content: tpl.content,
    negative_prompt: tpl.negative_prompt,
    notes: tpl.notes,
    variables: tpl.variables,
    output_contract: tpl.output_contract,
    seed_version: PROMPT_VERSION,
  };
}

/**
 * @returns {{inserted:number, updated:number, skipped:number, version:string}}
 */
function seedTemplatesDetailed(store) {
  if (!store) return { inserted: 0, updated: 0, skipped: 0, version: PROMPT_VERSION };

  const applied = String(store.getSettings().prompt_seed_version || '0');
  const rows = store.list('prompt_templates');
  const byKey = new Map();
  for (const row of rows) if (row.key) byKey.set(row.key, row);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const tpl of DEFAULT_TEMPLATES) {
    const current = byKey.get(tpl.key);
    if (!current) {
      store.insert('prompt_templates', Object.assign({
        is_favorited: false,
        is_builtin: true,
        is_customized: false,
      }, payloadOf(tpl)));
      inserted++;
      continue;
    }
    // 用户自建的同 key 模板：可能是故意覆盖，绝不碰
    if (!current.is_builtin) { skipped++; continue; }
    // 用户改过的内置模板：升级会覆盖他的修改，跳过
    if (current.is_customized) { skipped++; continue; }
    if (applied === PROMPT_VERSION) { skipped++; continue; }

    const patch = {};
    for (const f of SYNC_FIELDS) patch[f] = payloadOf(tpl)[f];
    store.update('prompt_templates', current.id, patch);
    updated++;
  }

  if (applied !== PROMPT_VERSION) store.setSettings({ prompt_seed_version: PROMPT_VERSION });
  return { inserted, updated, skipped, version: PROMPT_VERSION };
}

/** 兼容旧调用：返回改动的模板条数 */
function seedTemplates(store) {
  const r = seedTemplatesDetailed(store);
  return r.inserted + r.updated;
}

/** 启动自检用：模板库自身是否自洽 */
function checkTemplates() {
  return validateTemplates(DEFAULT_TEMPLATES);
}

module.exports = { DEFAULT_TEMPLATES, PROMPT_VERSION, seedTemplates, seedTemplatesDetailed, checkTemplates };
