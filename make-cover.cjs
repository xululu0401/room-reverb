#!/usr/bin/env node
/* 封面（1200×1200）：数字全部来自同一次引擎输出（先落盘 evidence/封面取值.json）。
 * 画法：生成临时 HTML → agent-browser 截图 → 按 1200×1200 裁切 → 01-room-reverb/cover.png。
 * 不手抄任何数字；页面内容高度必须 ≤ 1200 才允许出图（防页脚被切，批次 58 踩过）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = fs.existsSync(path.join(__dirname, '01-room-reverb')) ? __dirname : path.dirname(__dirname);
const APP = path.join(ROOT, '01-room-reverb');
const AB = '/Users/xululu/.workbuddy/binaries/node/versions/22.22.2-6/bin/agent-browser';
const SESSION = 'codex59-cover';
const PY = '/Users/xululu/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';
const C = require(path.join(APP, 'core.js'));

const v = C.compute(C.defaults());
if (!v.ok) { console.error('引擎没算干净，不画封面：', v.errors); process.exit(1); }
const bad = v.checks.filter((c) => !c.ok);
if (bad.length) { console.error('自检不通过，不画封面：', bad); process.exit(1); }

const out = {
  dims: [v.input.L, v.input.W, v.input.H], V: v.geometry.V, S: v.geometry.totalSurface,
  A500: v.absorption.total[2], rt500: v.rt60[2], bands: v.bands, rt: v.rt60,
  target: v.input.targetRT60, need: v.required.need, A_target: v.required.A_target,
  schroeder: v.schroeder, cd: v.criticalDistance, modes: v.modes.length, freqs: v.modesByFreq.length,
  first6: v.modesByFreq.slice(0, 6).map((m) => m.f), maxGap: v.gaps.maxGap,
  checks: v.checks.length, selfFail: v.selfCheckFailures,
  panelFree: v.plan.options.filter((o) => o.key === 'panel_free')[0].area,
  stamp: new Date().toISOString(),
};
fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence', '封面取值.json'), JSON.stringify(out, null, 2));

const R2 = (x) => x.toFixed(2);
const R3 = (x) => x.toFixed(3);
const F1 = (x) => x.toFixed(1);

const bars = v.bands.map((f, i) => {
  const pct = (v.rt60[i] / Math.max.apply(null, v.rt60)) * 100;
  const hi = f === 500;
  return `<div class="row"><span class="fq${hi ? ' hi' : ''}">${f} Hz</span>
    <span class="bar"><i style="width:${pct.toFixed(1)}%;background:${hi ? '#0f6a72' : '#a9c3c8'}"></i></span>
    <span class="val${hi ? ' hi' : ''}">${R3(v.rt60[i])} s</span></div>`;
}).join('');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:1200px;background:#f4f1e9;color:#12303a;overflow:hidden;
  font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;padding:44px 54px;position:relative}
h1{font-size:58px;letter-spacing:1px;line-height:1.08}
.sub{margin-top:12px;font-size:24px;color:#3f5b66;line-height:1.4}
.sub b{color:#0b4f56}
.hero{margin-top:22px;background:linear-gradient(180deg,#0f6a72,#0b4f56);color:#fff;border-radius:20px;
  padding:22px 32px;display:flex;justify-content:space-between;align-items:flex-end}
.hero .cap{font-size:22px;opacity:.88}
.hero .big{font-size:92px;font-weight:800;line-height:1;letter-spacing:-3px}
.hero .right{text-align:right;font-size:22px;line-height:1.6}
.hero .right b{font-size:26px}
.sec{margin-top:20px;font-size:23px;font-weight:700;color:#3f5b66}
.rows{margin-top:8px}
.row{display:flex;align-items:center;gap:14px;margin:6px 0;font-size:22px}
.fq{width:120px;color:#3f5b66}
.fq.hi{color:#0b4f56;font-weight:700}
.bar{flex:1;height:20px;background:#e6e2d8;border-radius:10px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:10px}
.val{width:130px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
.val.hi{color:#0b4f56}
.cards{display:flex;gap:14px;margin-top:18px}
.card{flex:1;border:1px solid #d7e2e6;background:#fff;border-radius:14px;padding:14px 16px}
.card .k{font-size:19px;color:#6d8590}
.card .v{font-size:30px;font-weight:800;color:#0b4f56;font-variant-numeric:tabular-nums;margin-top:2px}
.card .e{font-size:17px;color:#6d8590;margin-top:3px;line-height:1.35}
.foot{position:absolute;left:54px;right:54px;bottom:30px;font-size:17px;color:#6d8590;line-height:1.5}
.foot b{color:#3f5b66}
</style></head><body>
<h1>房间的混响时间</h1>
<div class="sub">这间房把声音拖多久、低频堆在哪儿、<b>要补多少吸声材料</b>才有用 ——
  全部由你填的长宽高与六个面的材料算出来。不测量、不联网、不内置产品参数。</div>

<div class="hero">
  <div><div class="cap">500 Hz 混响时间</div><div class="big">${R3(v.rt60[2])} s</div></div>
  <div class="right">
    目标 <b>${R2(v.input.targetRT60)} s</b> · 还差 <b>${R2(v.required.need)} m²</b><br>
    房间 ${v.input.L} × ${v.input.W} × ${v.input.H} m · ${R2(v.geometry.V)} m³ · 吸声量 ${R2(v.absorption.total[2])} m²
  </div>
</div>

<div class="sec">六段混响时间（同一份输入）</div>
<div class="rows">${bars}</div>

<div class="cards">
  <div class="card"><div class="k">低频驻波</div><div class="v">${v.modesByFreq.length} 个频率</div>
    <div class="e">${v.modes.length} 条轴向模式压在这些频率上，最低 ${F1(v.modesByFreq[0].f)} Hz；
      50–120 Hz 最宽的缝 ${F1(v.gaps.maxGap)} Hz</div></div>
  <div class="card"><div class="k">Schroeder 频率</div><div class="v">${F1(v.schroeder)} Hz</div>
    <div class="e">低于它按"一个个分开的驻波"行事，高于它才像扩散场</div></div>
  <div class="card"><div class="k">临界距离</div><div class="v">${R2(v.criticalDistance)} m</div>
    <div class="e">比它近听到的是直达声，比它远混响占比更大</div></div>
</div>

<div class="foot">
  <b>要压到 ${R2(v.input.targetRT60)} s</b>：目标吸声量 ${R2(v.required.A_target)} m²、当前 ${R2(v.absorption.total[2])} m²，
  缺口 ${R2(v.required.need)} m²（例如直接加 50 mm 多孔吸声板约 ${F1(v.plan.options.filter((o) => o.key === 'panel_free')[0].area)} m²）。<br>
  吸声系数是公开资料的典型参考值、可逐项改写，不代表任何具体产品；默认数据是虚构示例。自检 ${v.checks.length} 条 / 未过 ${v.selfCheckFailures} 条。
</div>
</body></html>`;

const tmp = path.join(ROOT, 'evidence', '封面.html');
fs.writeFileSync(tmp, html);
const shot = path.join(ROOT, 'evidence', '封面-原图.png');

try { execFileSync(AB, ['close', '--all'], { encoding: 'utf8', timeout: 60000 }); } catch (e) { /* 无会话也行 */ }
execFileSync(AB, ['--session', SESSION, '--profile', '/Users/xululu/.agent-browser/zhihu-profile',
  'open', 'file://' + tmp], { encoding: 'utf8', timeout: 180000 });
execFileSync(AB, ['--session', SESSION, 'set', 'viewport', '1200', '1200'], { encoding: 'utf8', timeout: 60000 });
const height = execFileSync(AB, ['--session', SESSION, 'eval',
  'JSON.stringify({h: document.documentElement.scrollHeight, foot: document.querySelector(".foot").getBoundingClientRect().bottom})'],
  { encoding: 'utf8', timeout: 60000 });
console.log('内容高度检查：' + height.trim().split('\n').filter(Boolean).pop());
execFileSync(AB, ['--session', SESSION, 'screenshot', '--full', shot], { encoding: 'utf8', timeout: 120000 });
execFileSync(AB, ['close', '--all'], { encoding: 'utf8', timeout: 60000 });

const py = `
from PIL import Image
im = Image.open(${JSON.stringify(shot)})
out = im.crop((0, 0, min(1200, im.width), min(1200, im.height)))
out.save(${JSON.stringify(path.join(APP, 'cover.png'))})
print('cover', out.size)
`;
console.log(execFileSync(PY, ['-c', py], { encoding: 'utf8' }).trim());
