/**
 * template.js — 提示词模板的公共填充逻辑
 * ------------------------------------------------------------------
 * 模板正文里的 {{变量}} 由页面按上下文填入。
 * 抽成一个函数，是为了让「没填的变量」统一变成「（未填写）」，
 * 而不是各自用 replace 拼出 undefined / [object Object] 塞给模型。
 */

/** 按 variables 对象填充模板正文；剩余未填变量统一留占位提示 */
export function fillTemplate(tpl, vars = {}) {
  if (!tpl) return '';
  let out = String(tpl.content || '');
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }
  return out.replace(/\{\{[^}]+\}\}/g, '（未填写）');
}

/** 按 key 或 template_type 找模板（key 优先，便于以后同类型多版本） */
export function findTemplate(list, keyOrType) {
  const rows = Array.isArray(list) ? list : [];
  return rows.find((t) => t.key === keyOrType) || rows.find((t) => t.template_type === keyOrType) || null;
}

/** 取 system 提示词，模板缺失时用兜底 */
export function systemOf(tpl, fallback = '') {
  return (tpl && tpl.system) || fallback;
}

/** 模板变量清单（优先用声明的 variables，老模板回退到正则扫描） */
export function variablesOf(tpl) {
  if (!tpl) return [];
  if (Array.isArray(tpl.variables) && tpl.variables.length) return tpl.variables.map((v) => v.name);
  const out = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(String(tpl.content || '')))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
