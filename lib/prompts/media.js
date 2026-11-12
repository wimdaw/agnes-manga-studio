/**
 * prompts/media.js — 单张图片 / 单条视频的提示词生成
 * ------------------------------------------------------------------
 * 这两条输出的是纯文本（不是 JSON），由分镜页「批量补提示词」逐镜调用。
 * 与分镜表里的 image_prompt/video_prompt 保持同一套写法，
 * 否则批量补出来的图会和整表生成的风格对不上。
 */
'use strict';

const { TEXT_DISCIPLINE, ASSET_RULES, block } = require('./ctx');

const imagePrompt = {
  key: 'image_prompt',
  name: '分镜图片提示词 · 单镜',
  template_type: 'image_prompt',
  stage: 'media',
  order: 10,
  version: 2,
  system: '你是竖屏漫剧的 AI 图像提示词工程师。你写的提示词会直接进文生图模型，必须一次成图、不用二次修。',
  content: block(
    '【任务】',
    '为下面这一个分镜写一条英文静帧提示词（image prompt）。只写一条，不要解释。',
    '',
    '【镜头信息】',
    '景别：{{景别}}',
    '画面描述：{{画面描述}}',
    '人物：{{人物}}',
    '场景：{{场景}}',
    '动作：{{动作}}',
    '画风：{{画风}}',
    '',
    '【资产清单】',
    '{{资产清单}}',
    '',
    '【写法要求】',
    '1. 顺序固定：景别 → 主体与动作 → 环境 → 光线与色彩 → 画风 → 一致性锚点。',
    '2. 40-80 个英文单词，一句话为主，最多三句；不要分点、不要换行。',
    '3. 只描述这一瞬间的静止画面，不要写镜头运动、不要写「然后」。',
    '4. 人物外观以资产设定为准，不得改发型、服装、年龄。',
    '5. 不要出现文字、字幕、水印、logo、分屏、多格漫画、多余的手指。',
    ASSET_RULES,
    '',
    TEXT_DISCIPLINE,
  ),
  negative_prompt: 'low quality, blurry, distorted face, extra fingers, deformed hands, watermark, text, logo, split screen, comic panels',
  notes: '批量补图片提示词：一次一条，英文，静态画面',
  variables: [
    { name: '景别', label: '景别', required: false, example: '近景' },
    { name: '画面描述', label: '画面描述', required: true, example: '雨水打在铁皮棚上，女人攥着化验单' },
    { name: '人物', label: '人物', required: false, example: '@林晚' },
    { name: '场景', label: '场景', required: false, example: '@城中村巷口' },
    { name: '动作', label: '动作', required: false, example: '把单子揉成一团' },
    { name: '画风', label: '画风', required: false, example: '三渲二国风' },
    { name: '资产清单', label: '资产清单', required: false, example: '由系统自动填入，可留空' },
  ],
  output_contract: { type: 'text', fields: [] },
};

const videoPrompt = {
  key: 'video_prompt',
  name: '图生视频运动提示词 · 单镜',
  template_type: 'video_prompt',
  stage: 'media',
  order: 20,
  version: 2,
  system: '你是 AI 视频的运动提示词工程师。你只描述「画面怎么动」，不重复已经画好的静态外观。',
  content: block(
    '【任务】',
    '为下面这一个分镜写一条英文运动提示词（video prompt）。只写一条，不要解释。',
    '',
    '【镜头信息】',
    '画面描述：{{画面描述}}',
    '人物：{{人物}}',
    '场景：{{场景}}',
    '动作：{{动作}}',
    '台词：{{台词}}',
    '情绪：{{情绪}}',
    '镜头运动：{{镜头运动}}',
    '时长：{{时长}}',
    '',
    '【资产清单】',
    '{{资产清单}}',
    '',
    '【写法要求】',
    '1. 首帧必须与给定的分镜图一致：不要新增角色、不要改变服装和场景结构。',
    '2. 30-60 个英文单词，只写运动：主体动作顺序 → 镜头运动 → 结尾停驻。',
    '3. 镜头运动只能选一种：push in / pull out / pan left / pan right / orbit / handheld / static。',
    '4. 一个连续长镜头，禁止切镜、转场、闪回、分屏。',
    '5. 不要写台词内容、不要写字幕、不要写「然后画面变成」。',
    '6. 动作幅度要匹配时长：{{时长}} 秒内只完成一个完整动作。',
    ASSET_RULES,
    '',
    TEXT_DISCIPLINE,
  ),
  negative_prompt: 'low quality, blurry, distorted face, flickering, unstable motion, extra characters, scene change, camera cut, text, watermark',
  notes: '批量补视频提示词：只描述运动与运镜，首帧与分镜图一致',
  variables: [
    { name: '画面描述', label: '画面描述', required: true, example: '女人站在巷口，雨水顺着棚檐落下' },
    { name: '人物', label: '人物', required: false, example: '@林晚' },
    { name: '场景', label: '场景', required: false, example: '@城中村巷口' },
    { name: '动作', label: '动作', required: false, example: '缓慢抬头看向镜头' },
    { name: '台词', label: '台词', required: false, example: '（可留空）' },
    { name: '情绪', label: '情绪', required: false, example: '压抑后的决绝' },
    { name: '镜头运动', label: '镜头运动', required: false, example: 'push in' },
    { name: '时长', label: '时长（秒）', required: false, example: '3' },
    { name: '资产清单', label: '资产清单', required: false, example: '由系统自动填入，可留空' },
  ],
  output_contract: { type: 'text', fields: [] },
};

module.exports = [imagePrompt, videoPrompt];
