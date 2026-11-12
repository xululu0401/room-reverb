/* 房间的混响时间 · 界面层
 * 只做四件事：读输入 → 调 AppCore.compute → 把结果画出来（三步向导 + 房间声学体检报告）→ 导出。
 * 页面上每一个数字都来自同一次 compute 的返回对象，页面不自己二次计算
 * （例外只有纯粹用来画条形长度的比例，逐处标注）。
 */
(function () {
  'use strict';
  const A = window.AppCore;

  const SLUG = 'room-reverb';
  const TITLE = '房间的混响时间';
  const VERSION = '1.0.0';
  const STORE_KEY = 'room-reverb::v1';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const RT = (x) => A.fmtRT(x) + ' s';
  const Hz = (x) => A.fmtHz(x) + ' Hz';
  const M2 = (x) => A.fmtM2(x);

  const FIELDS = ['L', 'W', 'H', 'targetRT60', 'speakerDistance'];
  const IDS = { L: 'p-L', W: 'p-W', H: 'p-H', targetRT60: 'p-target', speakerDistance: 'p-spk' };

  let last = null;          // 最近一次 compute 的返回，导出与处方用
  let counter = 0;          // 重算次数（自检用）
  let view = 'inputs';      // inputs | materials | extras
  /* 「最后写进去的输入」。材料表是 render() 动态生成的，首次 writeInputs() 时它还不存在 ——
     所以读输入时凡是 DOM 里没有的控件，一律回落到这份状态，绝不对 null 取属性。
     （这个坑是本轮真实踩到的：页面初始化直接抛 TypeError，整页全白。） */
  let currentInputs = null;

  /* ───────── 读 / 写输入 ───────── */
  function readInputs() {
    const d = currentInputs || A.defaults();
    const mats = {};
    A.surfaceRows().forEach((s) => {
      const el = $('m-' + s.key);
      mats[s.key] = el ? el.value : d.materials[s.key];
    });
    const furniture = [];
    const fRows = document.querySelectorAll('#furn-body tr');
    if (fRows.length) {
      fRows.forEach((tr) => {
        const nm = tr.querySelector('.f-name'), mt = tr.querySelector('.f-mat'), ar = tr.querySelector('.f-area');
        if (!nm || !mt || !ar) return;                       // 结构不完整的行直接跳过，不抛异常
        furniture.push({ name: nm.value, material: mt.value, area: Number(ar.value) });
      });
    } else {
      (d.furniture || []).forEach((f) => furniture.push({ name: f.name, material: f.material, area: f.area }));
    }
    const rawCustom = [];
    const cBands = document.querySelectorAll('.c-band');
    if (cBands.length) cBands.forEach((el) => rawCustom.push(el.value === '' ? NaN : Number(el.value)));
    else (d.customA || A.defaults().customA).forEach((v) => rawCustom.push(v));
    const llEl = $('p-ll'), lwEl = $('p-lw');
    const lL = llEl ? (llEl.value === '' ? null : Number(llEl.value)) : d.listener.fromWallL;
    const lW = lwEl ? (lwEl.value === '' ? null : Number(lwEl.value)) : d.listener.fromWallW;
    return {
      L: Number($('p-L').value), W: Number($('p-W').value), H: Number($('p-H').value),
      materials: mats,
      customA: rawCustom,
      furniture: furniture,
      panel: { area: Number($('p-panel').value), material: $('p-pmat').value, surface: $('p-psurf').value },
      listener: { fromWallL: lL, fromWallW: lW },
      speakerDistance: Number($('p-spk').value),
      targetRT60: Number($('p-target').value),
    };
  }

  function writeInputs(inp) {
    const d = Object.assign(A.defaults(), inp || {});
    d.materials = Object.assign({}, A.defaults().materials, inp && inp.materials ? inp.materials : {});
    d.panel = Object.assign({}, A.defaults().panel, inp && inp.panel ? inp.panel : {});
    d.listener = Object.assign({}, A.defaults().listener, inp && inp.listener ? inp.listener : {});
    d.customA = Array.isArray(inp && inp.customA) ? inp.customA : A.defaults().customA;
    /* 先把状态写下来：后面无论 DOM 有没有准备好，readInputs 都能拿到一致的输入 */
    currentInputs = JSON.parse(JSON.stringify({
      L: d.L, W: d.W, H: d.H, materials: d.materials, customA: d.customA,
      furniture: (Array.isArray(inp && inp.furniture) ? inp.furniture : d.furniture).map((f) => ({ name: f.name, material: f.material, area: f.area })),
      panel: d.panel, listener: d.listener, speakerDistance: d.speakerDistance, targetRT60: d.targetRT60,
    }));
    FIELDS.forEach((k) => { if ($(IDS[k])) $(IDS[k]).value = d[k]; });
    A.surfaceRows().forEach((s) => { const el = $('m-' + s.key); if (el) el.value = d.materials[s.key]; });
    if ($('p-panel')) $('p-panel').value = d.panel.area;
    if ($('p-pmat')) $('p-pmat').value = d.panel.material;
    if ($('p-psurf')) $('p-psurf').value = d.panel.surface;
    if ($('p-ll')) $('p-ll').value = d.listener.fromWallL === null ? '' : d.listener.fromWallL;
    if ($('p-lw')) $('p-lw').value = d.listener.fromWallW === null ? '' : d.listener.fromWallW;
    document.querySelectorAll('.c-band').forEach((el, i) => { el.value = d.customA[i]; });
    renderFurniture(currentInputs.furniture);
    syncMaterialNotes();
  }

  function renderFurniture(rows) {
    const body = $('furn-body');
    body.innerHTML = '';
    (rows || []).forEach((f) => addFurnitureRow(f));
    $('f-empty').classList.toggle('hidden', (rows || []).length > 0);
  }

  function matOptions(sel) {
    return A.materialRows().map((m) => '<option value="' + m.id + '"' + (m.id === sel ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('');
  }

  function addFurnitureRow(f) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input class="f-name" type="text" maxlength="24" value="' + esc(f && f.name ? f.name : '软装') + '"></td>' +
      '<td><select class="f-mat">' + matOptions(f && f.material ? f.material : 'upholstered') + '</select></td>' +
      '<td><input class="f-area" type="number" step="any" min="0" max="200" value="' + (f && f.area != null ? f.area : 2) + '"></td>' +
      '<td><button class="sm del" title="删掉这一行">×</button></td>';
    tr.querySelector('.del').addEventListener('click', () => { tr.remove(); $('f-empty').classList.toggle('hidden', document.querySelectorAll('#furn-body tr').length > 0); render(); });
    tr.querySelector('.f-name').addEventListener('change', () => render());
    tr.querySelector('.f-mat').addEventListener('change', () => render());
    tr.querySelector('.f-area').addEventListener('change', () => render());
    $('furn-body').appendChild(tr);
    $('f-empty').classList.add('hidden');
  }

  /* ───────── 向导切换 ───────── */
  function goto(v) {
    view = v;
    ['inputs', 'materials', 'extras'].forEach((k) => { $('step-' + k).classList.toggle('hidden', k !== v); });
    document.querySelectorAll('#steps button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    const res = $('results');
    if (res) res.classList.toggle('hidden', v === 'inputs' && !last);
    window.scrollTo(0, 0);
  }

  /* ───────── 渲染 ───────── */
  function render(override) {
    const r = override || A.compute(readInputs());
    const errbox = $('errbox');
    if (!r.ok) {
      last = null;
      errbox.classList.remove('hidden');
      errbox.innerHTML = '<b>这几处要改一下：</b><ul>' + r.errors.map((e) => '<li>' + esc(e.msg) + '</li>').join('') + '</ul>';
      $('results').classList.add('hidden');
      return r;
    }
    errbox.classList.add('hidden');
    errbox.innerHTML = '';
    last = r;
    counter++;
    currentInputs = JSON.parse(JSON.stringify(r.input));   // DOM 是权威来源，回写状态

    renderTicket(r);
    renderMaterialsStep(r);
    renderFurnitureStep(r);
    renderBands(r);
    renderModes(r);
    renderMetrics(r);
    renderPlan(r);
    renderChecks(r);
    $('results').classList.remove('hidden');
    $('meta-line').innerHTML = '本页数字全部由上面这份输入算出（同一套公式与同一份材料表）。材料吸声系数是<b>公开资料的典型参考值</b>，' +
      '已列出并可逐项改写；<b>不代表任何具体产品</b>，也不引用任何标准条款。';
    return r;
  }

  function renderTicket(r) {
    $('t-rt').textContent = A.fmtRT(r.rt60[2]);
    $('t-verdict').textContent = r.verdictLabel;
    $('t-verdict').className = 'pill v-' + r.verdict;
    $('t-target').textContent = RT(r.input.targetRT60);
    $('t-need').textContent = r.required.need > 0 ? M2(r.required.need) : '已经达标';
    $('t-volume').textContent = A.fmt(r.geometry.V, 2) + ' m³';
    $('t-abs').textContent = M2(r.absorption.total[2]);
    $('t-dims').textContent = r.input.L + ' × ' + r.input.W + ' × ' + r.input.H + ' m';

    const b = r.rt60[2], target = r.input.targetRT60;
    let line;
    if (r.verdict === 'draggy') {
      line = '500 Hz 的混响时间是 <b>' + A.fmtRT(b) + ' s</b>，比目标（' + A.fmt(target, 2) + ' s）长 —— ' +
        '这个房间里说一句话，尾音会糊在后面。要压到目标，还需要补 <b>' + M2(r.required.need) + '</b> 的等效吸声量。';
    } else if (r.verdict === 'near') {
      line = '500 Hz 的混响时间是 <b>' + A.fmtRT(b) + ' s</b>，落在「接近」区间（0.4–0.6 s）—— ' +
        (r.required.need > 0 ? '离你设的目标（' + A.fmt(target, 2) + ' s）还差 <b>' + M2(r.required.need) + '</b> 的等效吸声量。' : '已经达到你设的目标。');
    } else {
      line = '500 Hz 的混响时间是 <b>' + A.fmtRT(b) + ' s</b>，落在「干」区间（&lt; 0.4 s）——' +
        (r.required.need > 0 ? '离你设的目标（' + A.fmt(target, 2) + ' s）还差 <b>' + M2(r.required.need) + '</b>。' : '已经达到你设的目标。');
    }
    $('t-line').innerHTML = line;
  }

  /* 第 2 步：逐面材料 + 实时累积 */
  function renderMaterialsStep(r) {
    const body = $('mat-body');
    body.innerHTML = '';
    A.surfaceRows().forEach((s) => {
      const row = r.absorption.bySurface[s.key];
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="nm">' + esc(s.name) + '</td>' +
        /* 必须同时给 id 与 data-k：readInputs/writeInputs 是按 id='m-<key>' 找控件的（找不着就回落到
           内存状态，于是「在下拉里换材料」会静默不生效 —— 本轮就是踩了这个坑，验收里才暴露出来）。 */
        '<td><select class="m-sel" id="m-' + s.key + '" data-k="' + s.key + '">' + matOptions(r.input.materials[s.key]) + '</select></td>' +
        '<td class="num">' + A.fmt(row.area, 2) + '</td>' +
        '<td class="num">' + A.fmt(row.coeff[2], 2) + '</td>' +
        '<td class="num strong">' + A.fmt(row.absorb[2], 2) + '</td>';
      tr.querySelector('.m-sel').addEventListener('change', () => render());
      body.appendChild(tr);
    });
    const extra = r.absorption.byFurniture[2] + r.absorption.panel[2];
    const tr2 = document.createElement('tr');
    tr2.className = 'sumrow';
    tr2.innerHTML = '<td class="nm">家具 + 吸声板</td><td class="muted">（在第 3 步里填）</td><td class="num">—</td><td class="num">—</td>' +
      '<td class="num strong">' + A.fmt(extra, 2) + '</td>';
    body.appendChild(tr2);

    const total = r.absorption.total[2];
    const target = r.required.A_target;
    $('mat-total').textContent = M2(total);
    $('mat-target').textContent = M2(target);
    $('mat-gap').textContent = r.required.need > 0 ? M2(r.required.need) : '已达标';
    $('mat-rt').textContent = RT(r.rt60[2]);
    /* 条形长度只是比例显示：min(100%, 当前/目标) */
    const w = target > 0 ? Math.min(100, total / target * 100) : 0;
    $('mat-bar').style.width = w.toFixed(1) + '%';
    $('mat-bar-txt').textContent = '当前吸声量是目标的 ' + A.fmt(w, 1) + '%';
  }

  function renderFurnitureStep(r) {
    $('fu-total').textContent = M2(r.absorption.byFurniture[2]);
    $('pa-total').textContent = M2(r.absorption.panel[2]);
    $('pa-hint').innerHTML = '按你自己填的面积与系数算：' + A.fmt(r.input.panel.area, 2) + ' m² × ' +
      A.fmt(A.coeffOf(r.input.panel.material, 2, r.input.customA), 2) + '（500 Hz 系数）= ' + M2(r.absorption.panel[2]) +
      '。如实说明：这个口径<b>没有</b>扣掉被吸声板遮住的那部分墙面原本的吸声量（保守算法）。';
  }

  /* 六段混响时间 */
  function renderBands(r) {
    const max = Math.max.apply(null, r.rt60);
    const body = $('band-body');
    body.innerHTML = '';
    r.bands.forEach((f, i) => {
      const tr = document.createElement('tr');
      if (f === 500) tr.className = 'now';
      const w = max > 0 ? (r.rt60[i] / max * 100) : 0;   // 比例显示
      tr.innerHTML = '<td class="nm">' + f + ' Hz' + (f === 500 ? '（主口径）' : '') + '</td>' +
        '<td class="num strong">' + A.fmtRT(r.rt60[i]) + ' s</td>' +
        '<td class="num opt">' + A.fmt(r.absorption.total[i], 2) + '</td>' +
        '<td class="num opt">' + A.fmt(r.absorption.total[i] / r.geometry.totalSurface, 2) + '</td>' +
        '<td class="bar"><span style="width:' + w.toFixed(1) + '%"></span></td>';
      body.appendChild(tr);
    });
  }

  /* 驻波清单 + 频率尺 */
  function renderModes(r) {
    const body = $('mode-body');
    body.innerHTML = '';
    r.modesByFreq.forEach((m) => {
      const tr = document.createElement('tr');
      const multi = m.members.length > 1;
      tr.innerHTML = '<td class="num strong">' + A.fmt(m.f, 1) + '</td>' +
        '<td class="num">' + m.deg + ' 条' + (multi ? '（同频）' : '') + '</td>' +
        '<td class="num opt">' + m.axisCount + ' 个方向</td>' +
        '<td class="nm2 opt">' + m.members.map(function (k) { return '(' + k + ')'; }).join(' ') + '</td>';
      body.appendChild(tr);
    });

    $('mode-count').textContent = r.modes.length + ' 条模式 / ' + r.modesByFreq.length + ' 个不同频率';
    $('mode-first').textContent = A.fmt(r.modesByFreq[0].f, 1) + ' Hz';
    const gaps = r.gaps.list;
    $('gap-count').textContent = gaps.length + ' 处';
    /* 无论有没有跨过阈值，都把「这一段里最宽的一条缝」摆出来 —— 0 处空档时读者更需要知道到底有多密 */
    const bandTxt = r.gapRange[0] + '–' + r.gapRange[1] + ' Hz 内共 ' + r.gaps.count + ' 个频率，最宽的一条缝是 ' +
      A.fmt(r.gaps.maxGap, 1) + ' Hz' +
      (r.gaps.maxPair ? '（' + A.fmt(r.gaps.maxPair[0], 1) + ' → ' + A.fmt(r.gaps.maxPair[1], 1) + ' Hz）' : '') + '。';
    $('gap-list').innerHTML = bandTxt + (gaps.length
      ? '跨过 ' + r.gapMinHz + ' Hz 阈值的有：' + gaps.map((g) => A.fmt(g.from, 1) + ' → ' + A.fmt(g.to, 1) + ' Hz（空 ' + A.fmt(g.gap, 1) + ' Hz）').join('；')
      : '没有一条跨过 ' + r.gapMinHz + ' Hz 这个阈值。');

    /* 频率尺：把每个「不同频率」画在 0–300 Hz 上（纯位置显示，不代表能量） */
    const W = 1000, left = 46, right = 16;
    const x = (f) => left + (Math.min(f, A.MODE_MAX_HZ) / A.MODE_MAX_HZ) * (W - left - right);
    let svg = '<svg viewBox="0 0 ' + W + ' 96" width="100%" height="96" role="img" aria-label="驻波频率尺">';
    svg += '<line x1="' + left + '" y1="60" x2="' + (W - right) + '" y2="60" stroke="#9fb3bb" stroke-width="1"/>';
    [0, 50, 100, 150, 200, 250, 300].forEach((f) => {
      svg += '<line x1="' + x(f).toFixed(1) + '" y1="56" x2="' + x(f).toFixed(1) + '" y2="64" stroke="#9fb3bb"/>';
      svg += '<text x="' + x(f).toFixed(1) + '" y="80" font-size="12" fill="#6d8590" text-anchor="middle">' + f + '</text>';
    });
    gaps.forEach((g) => {
      svg += '<rect x="' + x(g.from).toFixed(1) + '" y="52" width="' + Math.max(1, x(g.to) - x(g.from)).toFixed(1) + '" height="16" fill="#b8560f22"/>';
    });
    r.modesByFreq.forEach((m) => {
      const h = 10 + Math.min(30, (m.deg - 1) * 5);
      const y = 60 - h;
      svg += '<rect x="' + (x(m.f) - 1.6).toFixed(1) + '" y="' + y.toFixed(1) + '" width="3.2" height="' + h.toFixed(1) + '" fill="' + (m.axisCount >= 3 ? '#b8560f' : '#0f6a72') + '"/>';
    });
    svg += '<text x="' + left + '" y="20" font-size="12" fill="#6d8590">柱高 = 同一频率上有几条模式；橙色 = 三个方向同时参与</text>';
    svg += '<text x="' + left + '" y="38" font-size="12" fill="#6d8590">橙色底色 = 相邻频率间距 ≥ ' + r.gapMinHz + ' Hz 的空档</text>';
    svg += '</svg>';
    $('mode-ruler').innerHTML = svg;

    /* 听音位 */
    const lm = r.listener;
    $('lm-x').textContent = A.fmt(lm.x.pos, 2) + ' m（共 ' + A.fmt(lm.x.dim, 2) + ' m）';
    $('lm-y').textContent = A.fmt(lm.y.pos, 2) + ' m（共 ' + A.fmt(lm.y.dim, 2) + ' m）';
    $('lm-body').innerHTML = ['x', 'y', 'z'].map((k) => {
      const t = lm[k];
      return '<tr><td class="nm2">' + esc(t.name) + '</td><td class="num">' + A.fmt(t.f, 1) + '</td>' +
        '<td class="num">' + A.fmt(t.pos, 2) + '</td><td class="num opt">' + A.fmt(t.cos, 2) + '</td>' +
        '<td class="nm2 ' + (t.at === 'node' ? 'warn' : '') + '">' + esc(t.label) + '</td></tr>';
    }).join('');
    const spk = r.input.speakerDistance;
    $('lm-note').innerHTML = '音箱间距（等边三角形）＝ 听音距离 × √3 ＝ <b>' + A.fmt(spk * Math.sqrt(3), 2) + ' m</b>；' +
      '这是按你现在填的听音距离 <b>' + A.fmt(spk, 2) + ' m</b> 算的几何关系，不是摆位建议。';
  }

  function renderMetrics(r) {
    $('mt-sch').textContent = Hz(r.schroeder);
    $('mt-sch-note').innerHTML = '用 500 Hz 的 RT60（' + A.fmtRT(r.rt60[2]) + ' s）与体积（' + A.fmt(r.geometry.V, 2) +
      ' m³）算：2000·√(RT60/V)。<b>低于</b>这个频率，房间按「一个个分开的驻波」行事；高于它才更像统计声学的扩散场。';
    $('mt-count').textContent = A.fmt(r.modalCountAtSchroeder, 0) + ' 个';
    $('mt-count-note').innerHTML = '用 Weyl 公式算到 Schroeder 频率（' + Hz(r.schroeder) + '）为止的模态总数（含轴向 / 切向 / 斜向）。' +
      '本页的驻波清单只列<b>轴向</b>模式、且只到 ' + A.MODE_MAX_HZ + ' Hz，所以清单条数（' + r.modes.length + '）比这个数小得多 —— 两个口径不同，不要混着看。';
    $('mt-cd').textContent = A.fmt(r.criticalDistance, 2) + ' m';
    $('mt-cd-note').innerHTML = '0.141·√(A)（Q 取 1、A 用 500 Hz 吸声量 ' + M2(r.absorption.total[2]) + '）。' +
      '比这个距离近，听到的主要是音箱的直达声；比它远，房间的混响占比更大。';
    $('mt-surface').textContent = M2(r.geometry.totalSurface);
    $('mt-edge').textContent = A.fmt(r.geometry.edgeLen, 1) + ' m';
  }

  /* 处方：目标需要多少吸声量、要多少 m² */
  function renderPlan(r) {
    $('pl-target').textContent = RT(r.input.targetRT60);
    $('pl-atarget').textContent = M2(r.required.A_target);
    $('pl-acur').textContent = M2(r.absorption.total[2]);
    $('pl-need').textContent = r.required.need > 0 ? M2(r.required.need) : '已达标（不需要补）';

    const body = $('plan-body');
    body.innerHTML = '';
    r.plan.options.forEach((o, i) => {
      const tr = document.createElement('tr');
      const areaTxt = (o.area !== null && isFinite(o.area)) ? M2(o.area) : '没有解';
      const usable = (o.area !== null && isFinite(o.area) && o.area <= 200);
      tr.innerHTML = '<td class="nm2">' + esc(o.label) + '</td>' +
        '<td class="num strong">' + areaTxt + '</td>' +
        '<td class="nm2 ' + (o.note ? 'warn' : '') + '">' + esc(o.note || '可以做到') + '</td>' +
        '<td>' + (usable ? '<button class="sm apply" data-i="' + i + '">代入</button>' : '') + '</td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('.apply').forEach((b) => {
      b.addEventListener('click', () => {
        const o = r.plan.options[Number(b.dataset.i)];
        $('p-panel').value = Math.min(200, Math.max(0, Number(A.fmt(o.area, 2))));   // 代入后立刻重算
        $('p-pmat').value = o.key === 'carpet' ? 'carpet_mid' : (o.key === 'trap_free' ? 'bass_trap' : 'panel_50');
        goto('extras');
        render();
      });
    });

    /* 材料对照表：每种材料需要多少 m² 才能补上缺口 */
    const tb = $('presc-body');
    tb.innerHTML = '';
    r.prescriptions.slice(0, 12).forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="nm2">' + esc(p.name) + '</td>' +
        '<td class="num">' + A.fmt(p.coeff, 2) + '</td>' +
        '<td class="num strong">' + (p.freeArea === null ? '—' : M2(p.freeArea)) + '</td>' +
        '<td class="num ' + (p.installedFeasible === false ? 'warn' : '') + '">' +
        (p.installedArea == null ? '—' : (A.fmt(p.installedArea, 2) + ' m²' + (p.installedFeasible === false ? '（超过该面 ' + A.fmt(p.installedMax, 1) + ' m²）' : ''))) +
        '</td></tr>';
      tb.appendChild(tr);
    });

    /* 全屋统一处理的对照（不是推荐） */
    const ub = $('uniform-body');
    ub.innerHTML = r.uniformRef.map((u) =>
      '<tr><td class="nm2">' + esc(u.name) + '</td><td class="num">' + A.fmt(u.coeff, 2) + '</td>' +
      '<td class="num">' + A.fmt(u.A, 1) + '</td><td class="num strong">' + A.fmtRT(u.rt60) + ' s</td></tr>').join('');
  }

  function renderChecks(r) {
    $('sc-head').innerHTML = '共 ' + r.checks.length + ' 条自检，<b>' + (r.checks.length - r.selfCheckFailures) + ' 通过</b>' +
      (r.selfCheckFailures ? '，<b class="warn">' + r.selfCheckFailures + ' 条没过</b>' : '，0 条没过') + '。';
    $('sc-body').innerHTML = r.checks.map((c) =>
      '<div class="c"><span class="m ' + (c.ok ? 'p' : 'f') + '">' + (c.ok ? '✓' : '×') + '</span>' +
      '<span>' + esc(c.name) + (c.detail ? ' <span class="dt">' + esc(c.detail) + '</span>' : '') + '</span></div>').join('');
  }

  /* 只读 DOM 里已经存在的东西，不做「元素一定在」的假设：writeInputs 会在材料表建好之前被调用
     （首次初始化就是这样），那时 #mat-body 还是空的、furniture 行还没插 —— 早先这里直接读
     `$('m-'+key).value` 会抛 TypeError，把整个 writeInputs 打断。改成全部按状态判断。 */
  function syncMaterialNotes() {
    const d = currentInputs || A.defaults();
    const using = A.surfaceRows().some((s) => (d.materials || {})[s.key] === 'custom') ||
      (d.panel && d.panel.material === 'custom') ||
      (d.furniture || []).some((f) => f.material === 'custom');
    const note = $('custom-note');
    if (note) note.classList.toggle('hidden', !using);
  }

  /* ───────── 导出 ───────── */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function csv() {
    const r = last;
    const L = [];
    L.push('房间的混响时间 v' + VERSION);
    L.push('房间尺寸(m),' + r.input.L + '×' + r.input.W + '×' + r.input.H + ',体积(m³),' + r.geometry.V.toFixed(4));
    L.push('');
    L.push('频段(Hz),混响时间(s),总吸声量(m²),平均吸声系数');
    r.bands.forEach((f, i) => L.push([f, r.rt60[i].toFixed(4), r.absorption.total[i].toFixed(4), (r.absorption.total[i] / r.geometry.totalSurface).toFixed(4)].join(',')));
    L.push('');
    L.push('面,材料,面积(m²),500Hz 吸声系数,500Hz 吸声量(m²)');
    A.surfaceRows().forEach((s) => {
      const row = r.absorption.bySurface[s.key];
      L.push([s.name, (A.matById(r.input.materials[s.key]) || {}).name || '', row.area.toFixed(2), row.coeff[2].toFixed(3), row.absorb[2].toFixed(4)].join(','));
    });
    r.absorption.furniture.forEach((f) => L.push(['家具：' + f.name, f.materialName, f.area.toFixed(2), f.coeff[2].toFixed(3), f.absorb[2].toFixed(4)].join(',')));
    L.push(['吸声板', (A.matById(r.input.panel.material) || {}).name || '', r.input.panel.area.toFixed(2), r.absorption.panelCoeff[2].toFixed(3), r.absorption.panel[2].toFixed(4)].join(','));
    L.push('');
    L.push('驻波（轴向，≤' + A.MODE_MAX_HZ + ' Hz）');
    L.push('频率(Hz),nx,ny,nz,同频模式数,参与方向数');
    r.modes.forEach((m) => L.push([m.f.toFixed(3), m.nx, m.ny, m.nz, m.deg, m.axisCount].join(',')));
    L.push('');
    L.push('指标,值');
    L.push('Schroeder 频率(Hz),' + r.schroeder.toFixed(2));
    L.push('临界距离(m),' + r.criticalDistance.toFixed(4));
    L.push('Schroeder 以下模态数,' + r.modalCountAtSchroeder.toFixed(1));
    L.push('目标 RT60(s),' + r.input.targetRT60);
    L.push('目标吸声量(m²),' + r.required.A_target.toFixed(4));
    L.push('还需补的吸声量(m²),' + r.required.need.toFixed(4));
    L.push('自检,' + r.checks.length + ' 条 / 未过 ' + r.selfCheckFailures + ' 条');
    L.push('');
    L.push('说明,材料吸声系数取自公开资料的典型参考值，不代表任何具体产品；所有数字由本页输入算出。');
    download(SLUG + '-导出.csv', '\ufeff' + L.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function md() {
    const r = last;
    const L = [];
    L.push('# ' + TITLE + ' · 导出（v' + VERSION + '）');
    L.push('');
    L.push('- 房间：' + r.input.L + ' × ' + r.input.W + ' × ' + r.input.H + ' m（' + r.geometry.V.toFixed(2) + ' m³，内表面积 ' + r.geometry.totalSurface.toFixed(2) + ' m²）');
    L.push('- 500 Hz 混响时间：**' + A.fmtRT(r.rt60[2]) + ' s**（' + r.verdictLabel + '）；目标 ' + r.input.targetRT60 + ' s');
    L.push('- 目标吸声量 ' + r.required.A_target.toFixed(2) + ' m²，当前 ' + r.absorption.total[2].toFixed(2) + ' m²，**还需补 ' + r.required.need.toFixed(2) + ' m²**');
    L.push('');
    L.push('## 六段混响时间');
    L.push('');
    L.push('| 频段 | RT60 (s) | 总吸声量 (m²) | 平均吸声系数 |');
    L.push('|---|---|---|---|');
    r.bands.forEach((f, i) => L.push('| ' + f + ' Hz | ' + r.rt60[i].toFixed(3) + ' | ' + r.absorption.total[i].toFixed(2) + ' | ' + (r.absorption.total[i] / r.geometry.totalSurface).toFixed(3) + ' |'));
    L.push('');
    L.push('## 逐面材料（500 Hz）');
    L.push('');
    L.push('| 面 | 材料 | 面积 (m²) | 吸声系数 | 吸声量 (m²) |');
    L.push('|---|---|---|---|---|');
    A.surfaceRows().forEach((s) => {
      const row = r.absorption.bySurface[s.key];
      L.push('| ' + s.name + ' | ' + ((A.matById(r.input.materials[s.key]) || {}).name || '') + ' | ' + row.area.toFixed(2) + ' | ' + row.coeff[2].toFixed(2) + ' | ' + row.absorb[2].toFixed(2) + ' |');
    });
    r.absorption.furniture.forEach((f) => L.push('| 家具：' + f.name + ' | ' + f.materialName + ' | ' + f.area.toFixed(2) + ' | ' + f.coeff[2].toFixed(2) + ' | ' + f.absorb[2].toFixed(2) + ' |'));
    L.push('| 吸声板 | ' + ((A.matById(r.input.panel.material) || {}).name || '') + ' | ' + r.input.panel.area.toFixed(2) + ' | ' + r.absorption.panelCoeff[2].toFixed(2) + ' | ' + r.absorption.panel[2].toFixed(2) + ' |');
    L.push('');
    L.push('## 驻波（轴向模式，≤ ' + A.MODE_MAX_HZ + ' Hz：' + r.modes.length + ' 条模式 / ' + r.modesByFreq.length + ' 个不同频率）');
    L.push('');
    L.push('| 频率 (Hz) | 下标 (nx,ny,nz) | 同频模式数 | 参与方向数 |');
    L.push('|---|---|---|---|');
    r.modes.forEach((m) => L.push('| ' + m.f.toFixed(1) + ' | ' + m.nx + ',' + m.ny + ',' + m.nz + ' | ' + m.deg + ' | ' + m.axisCount + ' |'));
    L.push('');
    L.push('## 单点指标');
    L.push('');
    L.push('- Schroeder 频率：' + r.schroeder.toFixed(1) + ' Hz（低于它按一个个驻波看）');
    L.push('- 临界距离：' + r.criticalDistance.toFixed(2) + ' m（0.141·√A，Q=1）');
    L.push('- Schroeder 频率以下的模态总数（Weyl 口径）：' + r.modalCountAtSchroeder.toFixed(0));
    L.push('- ' + r.gapRange[0] + '–' + r.gapRange[1] + ' Hz 内间距 ≥ ' + r.gapMinHz + ' Hz 的空档：' + r.gaps.list.length + ' 处');
    L.push('');
    L.push('## 达到目标的处方（500 Hz 口径）');
    L.push('');
    r.plan.options.forEach((o) => L.push('- ' + o.label + '：' + ((o.area !== null && isFinite(o.area)) ? o.area.toFixed(2) + ' m²' : '没有解') + (o.note ? '（' + o.note + '）' : '')));
    L.push('');
    L.push('## 自检');
    L.push('');
    r.checks.forEach((c) => L.push('- ' + (c.ok ? '✓' : '×') + ' ' + c.name + (c.detail ? '（' + c.detail + '）' : '')));
    L.push('');
    L.push('> 材料吸声系数取自公开资料的典型参考值，可逐项改写，不代表任何具体产品；全部数字由上面这份输入算出，未联网、未实测。');
    download(SLUG + '-导出.md', L.join('\n'), 'text/markdown;charset=utf-8');
  }

  function jsonBackup() {
    const inp = readInputs();
    const payload = { app: SLUG, version: VERSION, savedAt: new Date().toISOString(), input: inp };
    download(SLUG + '-备份.json', JSON.stringify(payload, null, 2), 'application/json');
    return payload;
  }

  /* 结果卡 1080×1350：数字全部来自 last */
  function png() {
    const r = last;
    const cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    const g = cv.getContext('2d');
    g.fillStyle = '#f5f2ea'; g.fillRect(0, 0, 1080, 1350);
    g.fillStyle = '#12303a';
    g.font = '700 46px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(TITLE, 64, 96);
    g.font = '24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#3f5b66';
    g.fillText('房间 ' + r.input.L + ' × ' + r.input.W + ' × ' + r.input.H + ' m · ' + r.geometry.V.toFixed(2) + ' m³ · ' + r.geometry.totalSurface.toFixed(1) + ' m²', 64, 138);

    /* 主结论卡 */
    g.fillStyle = '#0f6a72'; roundRect(g, 64, 176, 952, 210, 18); g.fill();
    g.fillStyle = '#ffffff';
    g.font = '24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('500 Hz 混响时间（目标 ' + r.input.targetRT60.toFixed(2) + ' s）', 96, 226);
    g.font = '800 92px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(A.fmtRT(r.rt60[2]) + ' s', 96, 330);
    g.font = '30px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('判定：' + r.verdictLabel, 600, 330);

    /* 六段 */
    let y = 440;
    g.fillStyle = '#12303a';
    g.font = '700 28px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('六段混响时间', 64, y);
    y += 22;
    const maxRT = Math.max.apply(null, r.rt60);
    r.bands.forEach((f, i) => {
      y += 44;
      g.fillStyle = f === 500 ? '#0b4f56' : '#3f5b66';
      g.font = (f === 500 ? '700 ' : '') + '26px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      g.fillText(f + ' Hz', 64, y + 22);
      const w = maxRT > 0 ? (r.rt60[i] / maxRT) * 620 : 0;
      g.fillStyle = f === 500 ? '#0f6a72' : '#a9c3c8';
      g.fillRect(220, y, w, 26);
      g.fillStyle = '#12303a';
      g.font = '700 26px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      g.fillText(r.rt60[i].toFixed(3) + ' s', 860, y + 22);
    });

    /* 处方 */
    y += 78;
    g.fillStyle = '#12303a';
    g.font = '700 28px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('要压到目标还需要', 64, y);
    y += 52;
    g.font = '800 64px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#b8560f';
    g.fillText(r.required.need > 0 ? r.required.need.toFixed(2) + ' m² 等效吸声量' : '已经达标', 64, y);
    y += 48;
    g.fillStyle = '#3f5b66';
    g.font = '24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('当前 ' + r.absorption.total[2].toFixed(2) + ' m² · 目标 ' + r.required.A_target.toFixed(2) + ' m²（500 Hz 口径）', 64, y);
    y += 46;
    const optTxt = function (o, tail) {
      if (!o) return '没有解';
      return (o.area !== null && isFinite(o.area)) ? (o.area.toFixed(1) + ' m²' + (tail || '')) : '没有解（' + (o.note || '') + '）';
    };
    wrapText(g, '直接加 50 mm 多孔吸声板：约 ' + optTxt(r.plan.options[1]) +
      '；地面换中厚地毯：' + optTxt(r.plan.options[2], '（地面 ' + r.absorption.areas.floor.toFixed(1) + ' m²）'),
      '24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif', 952, 64, y, 32, '#3f5b66');

    /* 关键证据 */
    y += 120;
    g.fillStyle = '#12303a';
    g.font = '700 28px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('低频在哪儿堆着', 64, y);
    y += 40;
    g.font = '24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#3f5b66';
    const top = r.modesByFreq.slice(0, 6).map((m) => m.f.toFixed(1)).join(' / ');
    g.fillText('前六个轴向模式：' + top + ' Hz（' + r.modes.length + ' 条模式 / ' + r.modesByFreq.length + ' 个频率）', 64, y);
    y += 34;
    g.fillText('Schroeder 频率 ' + r.schroeder.toFixed(0) + ' Hz · 临界距离 ' + r.criticalDistance.toFixed(2) + ' m · 空档 ' + r.gaps.list.length + ' 处', 64, y);

    y += 56;
    g.fillStyle = '#6d8590';
    g.font = '21px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    wrapText(g, '材料吸声系数取自公开资料的典型参考值，可逐项改写，不代表任何具体产品；全部数字由同一套引擎算出，未联网、未实测。',
      '21px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif', 952, 64, y, 30, '#6d8590');
    g.fillText('自检 ' + r.checks.length + ' 条 / 未过 ' + r.selfCheckFailures + ' 条 · ' + new Date().toISOString().slice(0, 10), 64, 1306);

    cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = SLUG + '-结果卡.png';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }, 'image/png');
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }
  /* 按 measureText 折行 + 限行，行首不留标点 */
  function wrapText(g, text, font, maxW, x, y, lh, color) {
    g.font = font; g.fillStyle = color;
    const noLead = '，。、；：！？）」』%';
    let line = '', lines = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const t = line + ch;
      if (g.measureText(t).width > maxW && line) {
        if (noLead.indexOf(ch) >= 0) { line = t; continue; }
        g.fillText(line, x, y + lines * lh); lines++; line = ch;
        if (lines >= 4) return y + lines * lh;
      } else line = t;
    }
    if (line) { g.fillText(line, x, y + lines * lh); lines++; }
    return y + lines * lh;
  }

  /* ───────── 保存与恢复 ───────── */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: VERSION, savedAt: new Date().toISOString(), input: readInputs() }));
      $('saveinfo').innerHTML = '已保存到本机（' + new Date().toLocaleString('zh-CN') + '）。刷新页面会自动读回；换设备用「导出 JSON 备份」。';
    } catch (e) {
      $('saveinfo').innerHTML = '<span class="warn">保存失败：' + esc(String(e && e.message || e)) + '</span>';
    }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { $('saveinfo').innerHTML = '本机还没有保存过的输入。'; return false; }
      const o = JSON.parse(raw);
      writeInputs(o.input);
      $('saveinfo').innerHTML = '已从本机读回上次保存的输入（' + new Date(o.savedAt).toLocaleString('zh-CN') + '）。';
      return true;
    } catch (e) { return false; }
  }

  /* ───────── 初始化 ───────── */
  function init() {
    /* 静态下拉：吸声板材料、安装面（六个面的材料下拉由 render 逐行生成） */
    $('p-pmat').innerHTML = A.materialRows().map((m) => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('');
    $('p-psurf').innerHTML = A.surfaceRows().map((s) => '<option value="' + s.key + '">' + esc(s.name) + '</option>').join('');
    writeInputs(A.defaults());
    restore();
    /* 场景按钮 */
    const sc = $('scen');
    A.scenarios().forEach((s) => {
      const b = document.createElement('button');
      b.className = 'sm'; b.textContent = s.label; b.dataset.k = s.key;
      b.addEventListener('click', () => { writeInputs(Object.assign(A.defaults(), s.over)); render(); });
      sc.appendChild(b);
    });
    document.querySelectorAll('#steps button').forEach((b) => b.addEventListener('click', () => goto(b.dataset.v)));
    $('b-next1').addEventListener('click', () => goto('materials'));
    $('b-next2').addEventListener('click', () => goto('extras'));
    $('b-back2').addEventListener('click', () => goto('inputs'));
    $('b-back3').addEventListener('click', () => goto('materials'));
    $('b-see').addEventListener('click', () => { render(); goto('extras'); });
    $('b-add').addEventListener('click', () => { addFurnitureRow({ name: '软装', material: 'upholstered', area: 2 }); render(); });
    $('b-reset').addEventListener('click', () => { writeInputs(A.defaults()); render(); });
    $('b-save').addEventListener('click', save);
    $('b-import').addEventListener('click', () => $('f-import').click());
    $('f-import').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const o = JSON.parse(String(fr.result));
          writeInputs(o.input || o);
          render();
          $('saveinfo').innerHTML = '已导入备份（' + esc(f.name) + '）。';
        } catch (err) { $('saveinfo').innerHTML = '<span class="warn">导入失败：文件不是本页导出的备份</span>'; }
      };
      fr.readAsText(f);
    });
    $('b-csv').addEventListener('click', () => { render(); csv(); });
    $('b-md').addEventListener('click', () => { render(); md(); });
    $('b-json').addEventListener('click', () => { render(); jsonBackup(); });
    $('b-png').addEventListener('click', () => { render(); png(); });

    FIELDS.forEach((k) => { const el = $(IDS[k]); if (el) el.addEventListener('change', () => { render(); }); });
    /* 注意：不能写成 addEventListener('change', render) —— 那样事件对象会被当成 render(override)
       传进去，render 拿到一个 Event 当结果，r.ok 是 undefined，于是走进错误分支并去读 r.errors。
       本轮就是在这里踩的坑（G2 改吸声板面积时整页崩，页面还不显示任何错误）。
       所有监听一律包一层，保证 render 只拿到 undefined。 */
    ['p-panel', 'p-pmat', 'p-psurf', 'p-ll', 'p-lw'].forEach((id) => $(id).addEventListener('change', () => render()));
    document.querySelectorAll('.c-band').forEach((el) => el.addEventListener('change', () => { render(); syncMaterialNotes(); }));

    /* 材料表里切换选择后要刷新「自定义」提示 */
    $('mat-body').addEventListener('change', syncMaterialNotes);

    render();
    goto('inputs');
  }

  window.__app = {
    render: render, writeInputs: writeInputs, readInputs: readInputs, goto: goto,
    get last() { return last; }, get counter() { return counter; },
    csv: csv, md: md, jsonBackup: jsonBackup, png: png, save: save, restore: restore,
    addFurnitureRow: addFurnitureRow, TITLE: TITLE, VERSION: VERSION, SLUG: SLUG,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
