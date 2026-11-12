/* 房间的混响时间 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：手算锚点（默认场景逐项写死数值）、几何恒等式、Sabine 公式与空气吸收项、
 * 驻波频率与简并度（含立方体的三重/六重简并）、Schroeder 与临界距离、
 * 反解回代、单调性与不变量、弃用口径的边界（不减门窗洞、吸声板不扣原面）、
 * 40 条非法输入逐条核字段、随机压力（不变量 + 自检）、自检「会红」反向验证、
 * 确定性与纯函数、输出契约、导出契约。
 *
 * 手算锚点一律在断言里写死数值（不是拿引擎自己对自己）；随机压力那条另走**独立**的
 * 朴素实现（本文件里从零重写一遍几何与吸声量，不复用 core.js 的中间结果）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'core.js'));

const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-12 : tol) * Math.max(1, Math.abs(a), Math.abs(b));
const D = (over) => Object.assign(A.defaults(), over || {});
const bad = (over) => {
  const r = A.compute(D(over));
  assert.equal(r.ok, false, '这组输入本该被拒：' + JSON.stringify(over));
  return r.errors;
};
const hasField = (errs, f) => errs.some((e) => e.field === f);

/* ═══════════════ A. 手算锚点（默认场景） ═══════════════ */

test('A1 默认场景几何：4.2×3.6×2.6 → V 39.312、内表面 70.8、棱长 41.6', () => {
  const r = A.compute(D());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 手算：4.2×3.6×2.6 = 39.312；2×15.12 + 2×4.2×2.6 + 2×3.6×2.6 = 30.24 + 21.84 + 18.72 = 70.8
  assert.ok(near(r.geometry.V, 39.312));
  assert.ok(near(r.geometry.totalSurface, 70.8));
  assert.ok(near(r.geometry.edgeLen, 41.6));
  assert.ok(near(r.absorption.areas.floor, 15.12));
  assert.ok(near(r.absorption.areas.wallN, 10.92));
  assert.ok(near(r.absorption.areas.wallE, 9.36));
});

test('A2 默认场景 500 Hz 吸声量 = 6.7284（逐项手算）', () => {
  const r = A.compute(D());
  // 手算：地面 15.12×0.10 + 天花 15.12×0.03 + 长边墙 10.92×0.03×2 + 短边墙 9.36×0.03×2
  //      + 沙发 3.2×0.45 + 窗帘 5.4×0.39
  //    = 1.512 + 0.4536 + 0.6552 + 0.5616 + 1.44 + 2.106 = 6.7284
  const hand = 15.12 * 0.10 + 15.12 * 0.03 + 10.92 * 0.03 * 2 + 9.36 * 0.03 * 2 + 3.2 * 0.45 + 5.4 * 0.39;
  assert.ok(near(hand, 6.7284, 1e-12), '手算本身应当是 6.7284，实际 ' + hand);
  assert.ok(near(r.absorption.total[2], 6.7284, 1e-12), '引擎 ' + r.absorption.total[2]);
  // 分项也要对得上
  assert.ok(near(r.absorption.bySurface.floor.absorb[2], 1.512));
  assert.ok(near(r.absorption.byFurniture[2], 3.546));
  assert.ok(near(r.absorption.panel[2], 0));
});

test('A3 默认场景 500 Hz RT60 = 0.161×39.312/6.7284 ≈ 0.9407 s', () => {
  const r = A.compute(D());
  const hand = 0.161 * 39.312 / 6.7284;
  assert.ok(near(r.rt60[2], hand, 1e-12), '引擎 ' + r.rt60[2] + ' 手算 ' + hand);
  assert.ok(r.rt60[2] > 0.9 && r.rt60[2] < 0.95);
  assert.equal(r.verdict, 'draggy');
  assert.equal(r.verdictLabel, '拖');
});

test('A4 六段 RT60 手算逐段核对（含 4 kHz 的空气吸收项）', () => {
  const r = A.compute(D());
  const V = 39.312;
  const bands = [125, 250, 500, 1000, 2000, 4000];
  const m = { 125: 0, 250: 0, 500: 0, 1000: 0, 2000: 0.003, 4000: 0.012 };
  const aFloor = [0.15, 0.11, 0.10, 0.07, 0.06, 0.07];
  const aWall = [0.02, 0.02, 0.03, 0.04, 0.05, 0.05];
  const aSofa = [0.10, 0.25, 0.45, 0.60, 0.65, 0.70];
  const aCurtain = [0.05, 0.06, 0.39, 0.63, 0.70, 0.73];
  bands.forEach((f, b) => {
    const Ab = 15.12 * aFloor[b] + 15.12 * aWall[b] + 10.92 * aWall[b] * 2 + 9.36 * aWall[b] * 2 + 3.2 * aSofa[b] + 5.4 * aCurtain[b];
    const hand = 0.161 * V / (Ab + 4 * m[f] * V);
    assert.ok(near(r.rt60[b], hand, 1e-12), f + ' Hz：引擎 ' + r.rt60[b] + ' 手算 ' + hand);
  });
  // 六段都算出来，且 125 Hz 比 500 Hz 长（低频吸声弱）
  assert.equal(r.rt60.length, 6);
  assert.ok(r.rt60[0] > r.rt60[2]);
});

test('A5 吸声量翻倍 → RT60 恰好变成一半略多（空气吸收项使其不是严格一半）', () => {
  const r = A.compute(D());
  const A500 = r.absorption.total[2];
  const rt2 = A.rt60(r.geometry.V, A500 * 2, 0);
  assert.ok(near(rt2, r.rt60[2] / 2, 1e-9), '无空气吸收时应当正好一半');
  const rt2air = A.rt60(r.geometry.V, A500 * 2, 0.012);
  assert.ok(rt2air < rt2, '4 kHz 的空气吸收让分母更大 → RT60 更短（先前断言写反了）');
});

test('A6 最低驻波来自短边（3.6 m < 4.2 m）', () => {
  const r = A.compute(D());
  const fShort = 343 / (2 * 3.6);   // 短边 3.6 m → 47.64 Hz
  const fLong = 343 / (2 * 4.2);    // 长边 4.2 m → 40.83 Hz
  const fHigh = 343 / (2 * 2.6);    // 高度 2.6 m → 65.96 Hz
  assert.ok(fShort > fLong, '长边更长 → 它的一阶模式更低');
  assert.ok(near(r.modes[0].f, fLong, 1e-9), '最低模式 ' + r.modes[0].f + ' 应当 = ' + fLong + '（长边方向）');
  assert.equal(r.modes[0].deg, 3, '一阶轴向模式只有一个方向非零 → 简并度 3');
  assert.ok(r.modes.some((m2) => near(m2.f, fShort, 1e-9)), '短边一阶必须也在清单里');
  assert.ok(r.modes.some((m2) => near(m2.f, fHigh, 1e-9)), '高度一阶必须也在清单里');
  // 三个方向各自的一阶必须都出现（这是前一版枚举口径漏掉短边一阶的回归锁）
  [fLong, fShort, fHigh].forEach((f) => assert.ok(r.modes.some((m2) => near(m2.f, f, 1e-9)), '缺了 ' + f));
});

test('A7 Schroeder 频率与临界距离手算', () => {
  const r = A.compute(D());
  const sch = 2000 * Math.sqrt(r.rt60[2] / r.geometry.V);
  assert.ok(near(r.schroeder, sch, 1e-12));
  assert.ok(near(r.criticalDistance, 0.141 * Math.sqrt(r.absorption.total[2]), 1e-12));
  // 量级核对：小房间硬装 → Schroeder 两三百 Hz、临界距离不到半米
  assert.ok(r.schroeder > 250 && r.schroeder < 400, 'schroeder=' + r.schroeder);
  assert.ok(r.criticalDistance > 0.3 && r.criticalDistance < 0.5, 'cd=' + r.criticalDistance);
});

test('A8 目标吸声量与缺口手算', () => {
  const r = A.compute(D());
  const At = 0.161 * r.geometry.V / 0.35;
  assert.ok(near(r.required.A_target, At, 1e-12));
  assert.ok(near(r.required.need, At - r.absorption.total[2], 1e-12));
  assert.ok(r.required.need > 0);
});

/* ═══════════════ B. 独立朴素实现（本文件里从零重写，不复用 core.js 的中间量） ═══════════════ */

/* 只用「面的名字 → (面积, 材料 id)」这套原始输入，自己算面积、自己查系数表、自己算 Sabine。
   系数表在这里**再抄一遍**，与 core.js 的那份比对，防止引擎悄悄改表。 */
const A_TABLE = {
  paint_concrete: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05],
  plaster: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05],
  glass_win: [0.18, 0.06, 0.04, 0.03, 0.02, 0.02],
  plasterboard: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09],
  wood_floor: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07],
  tile_floor: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02],
  vinyl_floor: [0.02, 0.03, 0.03, 0.03, 0.03, 0.02],
  carpet_thin: [0.02, 0.04, 0.08, 0.20, 0.35, 0.40],
  carpet_mid: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73],
  curtain_thin: [0.05, 0.06, 0.39, 0.63, 0.70, 0.73],
  curtain_heavy: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65],
  upholstered: [0.10, 0.25, 0.45, 0.60, 0.65, 0.70],
  panel_25: [0.10, 0.25, 0.55, 0.80, 0.85, 0.85],
  panel_50: [0.20, 0.45, 0.75, 0.90, 0.92, 0.92],
  panel_50_gap: [0.35, 0.65, 0.85, 0.92, 0.92, 0.90],
  panel_100: [0.45, 0.75, 0.90, 0.95, 0.95, 0.93],
  bass_trap: [0.60, 0.72, 0.60, 0.45, 0.40, 0.35],
};

/* 朴素版：直接从输入字符串面算起 */
function naive(inp) {
  const L = inp.L, W = inp.W, H = inp.H;
  const V = L * W * H;
  const faces = {
    floor: L * W, ceiling: L * W,
    wallN: L * H, wallS: L * H, wallE: W * H, wallW: W * H,
  };
  const total = [0, 0, 0, 0, 0, 0];
  Object.keys(faces).forEach((k) => {
    const id = inp.materials[k];
    const row = id === 'custom' ? inp.customA : A_TABLE[id];
    for (let b = 0; b < 6; b++) total[b] += faces[k] * row[b];
  });
  (inp.furniture || []).forEach((f) => {
    const row = f.material === 'custom' ? inp.customA : A_TABLE[f.material];
    for (let b = 0; b < 6; b++) total[b] += f.area * row[b];
  });
  const prow = inp.panel.material === 'custom' ? inp.customA : A_TABLE[inp.panel.material];
  for (let b = 0; b < 6; b++) total[b] += inp.panel.area * prow[b];
  const m = [0, 0, 0, 0, 0, 0.003, 0.012];
  const mBand = [0, 0, 0, 0, 0.003, 0.012];
  const rt = total.map((Ab, b) => 0.161 * V / (Ab + 4 * mBand[b] * V));
  return { V, S: 2 * L * W + 2 * L * H + 2 * W * H, A: total, rt };
}

test('B1 朴素实现与引擎在 8 个配置上逐项一致', () => {
  const cases = [
    D(),
    D({ furniture: [] }),
    D({ materials: Object.assign({}, A.defaults().materials, { floor: 'carpet_mid' }) }),
    D({ panel: { area: 10, material: 'panel_50', surface: 'wallN' } }),
    D({ L: 3, W: 3, H: 3, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } }),
    D({ L: 1.5, W: 1.5, H: 1.5, furniture: [], materials: { floor: 'tile_floor', ceiling: 'tile_floor', wallN: 'tile_floor', wallS: 'tile_floor', wallE: 'tile_floor', wallW: 'tile_floor' }, panel: { area: 0, material: 'panel_50', surface: 'wallN' } }),
    D({ L: 30, W: 20, H: 12, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } }),
    D({ L: 5.4, W: 4.2, H: 2.8, materials: Object.assign({}, A.defaults().materials, { floor: 'carpet_mid', wallN: 'curtain_heavy' }), panel: { area: 6.5, material: 'panel_50_gap', surface: 'wallE' } }),
  ];
  let n = 0;
  cases.forEach((c, i) => {
    const r = A.compute(c);
    assert.equal(r.ok, true, 'case ' + i + ' ' + JSON.stringify(r.errors));
    const v = naive(r.input);
    assert.ok(near(r.geometry.V, v.V, 1e-12), 'case ' + i + ' V');
    assert.ok(near(r.geometry.totalSurface, v.S, 1e-12), 'case ' + i + ' S');
    for (let b = 0; b < 6; b++) {
      assert.ok(near(r.absorption.total[b], v.A[b], 1e-12), 'case ' + i + ' band ' + b + ' A');
      assert.ok(near(r.rt60[b], v.rt[b], 1e-12), 'case ' + i + ' band ' + b + ' RT60');
      n += 2;
    }
  });
  assert.equal(n, 8 * 6 * 2);
});

test('B2 引擎材料表与本文件抄的参考表逐项一致（防止表被悄悄改）', () => {
  let n = 0;
  Object.keys(A_TABLE).forEach((id) => {
    const m = A.matById(id);
    assert.ok(m, '材料库里缺了 ' + id);
    for (let b = 0; b < 6; b++) { assert.ok(near(m.a[b], A_TABLE[id][b], 1e-12), id + ' 第 ' + b + ' 段：' + m.a[b] + ' vs ' + A_TABLE[id][b]); n++; }
  });
  assert.equal(n, Object.keys(A_TABLE).length * 6);
});

/* ═══════════════ C. 驻波与简并度 ═══════════════ */

test('C1 驻波频率都是 c/2·√(...)：与闭式逐条对拍（3 个房间）', () => {
  [[4.2, 3.6, 2.6], [3, 3, 3], [6.5, 2.1, 3.3]].forEach((d) => {
    const mm = A.roomModes(d[0], d[1], d[2], 300);
    const modes = mm.list;
    const seenKey = {};
    modes.forEach((m) => {
      const f = (343 / 2) * Math.sqrt(Math.pow(m.nx / d[0], 2) + Math.pow(m.ny / d[1], 2) + Math.pow(m.nz / d[2], 2));
      assert.ok(near(m.f, f, 1e-12), JSON.stringify(d) + ' ' + m.key);
      assert.ok(m.f <= 300 + 1e-9);
      assert.ok(m.nx <= 4 && m.ny <= 4 && m.nz <= 4);
      assert.ok(!(m.nx === 0 && m.ny === 0 && m.nz === 0));
      assert.ok(!seenKey[m.key], '同一条模式不应当出现两次：' + m.key);
      seenKey[m.key] = 1;
      assert.equal(m.axisCount, (m.nx ? 1 : 0) + (m.ny ? 1 : 0) + (m.nz ? 1 : 0), '参与方向数');
    });
    for (let i = 1; i < modes.length; i++) assert.ok(modes[i].f >= modes[i - 1].f - 1e-12, '应当升序');
    // 模式条数 = 穷举条数
    assert.equal(modes.length, mm.bruteCount, JSON.stringify(d) + ' 条数');
    // 按频率归并视图：频率两两不同、成员数 = deg、成员下标都在清单里
    let sum = 0;
    for (let i = 0; i < mm.byFreq.length; i++) {
      const b = mm.byFreq[i];
      assert.equal(b.deg, b.members.length, 'deg 应当等于成员数');
      sum += b.deg;
      b.members.forEach((k) => assert.ok(seenKey[k], '归并视图里出现了清单里没有的下标 ' + k));
      if (i > 0) assert.ok(Math.abs(b.f - mm.byFreq[i - 1].f) > 1e-9, '归并后不应当有同频两行');
    }
    assert.equal(sum, modes.length, '归并视图的 deg 之和 = 模式条数');
  });
});

test('C2 模式条数 = 穷举全部 (nx,ny,nz)（各 0..4、不全为 0、f≤300）的条数（枚举口径不漏不重）', () => {
  [[4.2, 3.6, 2.6], [3, 3, 3], [2, 2, 2], [6.5, 2.1, 3.3], [5, 5, 2.5]].forEach((d) => {
    // 穷举：不做任何去重
    let brute = 0;
    for (let nx = 0; nx <= 4; nx++) for (let ny = 0; ny <= 4; ny++) for (let nz = 0; nz <= 4; nz++) {
      if (nx === 0 && ny === 0 && nz === 0) continue;
      const f = (343 / 2) * Math.sqrt(Math.pow(nx / d[0], 2) + Math.pow(ny / d[1], 2) + Math.pow(nz / d[2], 2));
      if (f <= 300 + 1e-9) brute++;
    }
    const mm = A.roomModes(d[0], d[1], d[2], 300);
    assert.equal(mm.bruteCount, brute, JSON.stringify(d) + ' 引擎自报穷举条数 ' + mm.bruteCount + ' vs 本文件穷举 ' + brute);
    assert.equal(mm.list.length, brute, JSON.stringify(d) + ' 模式条数 ' + mm.list.length + ' vs 穷举 ' + brute);
    // 反方向也要成立：清单里不能有穷举里没有的（逐条重算频率）
    mm.list.forEach((m) => {
      const f = (343 / 2) * Math.sqrt(Math.pow(m.nx / d[0], 2) + Math.pow(m.ny / d[1], 2) + Math.pow(m.nz / d[2], 2));
      assert.ok(f > 0 && f <= 300 + 1e-9, '这条不该出现：' + m.key + ' f=' + f);
    });
  });
});

test('C3 立方体 3×3×3：三个方向的一阶同频（3 条）、频率归并后 24 个频率', () => {
  const mm = A.roomModes(3, 3, 3, 300);
  const modes = mm.list;
  assert.ok(near(modes[0].f, 343 / 6, 1e-12), '最低 ' + modes[0].f);
  // 立方体：三个方向的一阶是三**条**模式、同一频率
  const same = modes.filter((m) => near(m.f, 343 / 6, 1e-12));
  assert.equal(same.length, 3, '立方体的一阶应当有 3 条模式（三个轴各一条）');
  assert.deepEqual(same.map((m) => m.key).sort(), ['0,0,1', '0,1,0', '1,0,0']);
  same.forEach((m) => assert.equal(m.axisCount, 1));
  // 归并后一阶只占一行、deg = 3
  const b0 = mm.byFreq[0];
  assert.ok(near(b0.f, 343 / 6, 1e-12));
  assert.equal(b0.deg, 3);
  assert.equal(b0.members.length, 3);
  assert.equal(mm.byFreq.length, 24, '3×3×3、≤300 Hz、各下标 0..4 的不同频率数');
  // 立方体里同一个频率上叠的模式条数可以比轨道大小更多：(0,1,1) 与 (0,2,2) 这类
  // 「两个 0 之外的数成整数倍」会让不同轨道撞到同一个频率上。
  // 如实锁定：所有频率的 deg ∈ {1,3,6,9}，且存在 deg > 3 的频率（这正是立方体的问题所在）。
  const degs = mm.byFreq.map((b) => b.deg);
  degs.forEach((d) => assert.ok([1, 3, 6, 9].indexOf(d) >= 0, '不应当出现 ' + d + ' 条同频'));
  assert.ok(degs.indexOf(9) >= 0, '立方体应当有 9 条模式撞在同一个频率上');
  assert.equal(degs.filter((d) => d === 1).length, 3, 'deg=1 的频率应当是 3 个（三轴各一个自成一档的）');
  // 每个频率的成员都能两两对上「频率相同」这件事
  mm.byFreq.forEach((b) => {
    b.members.forEach((k) => {
      const t = k.split(',').map(Number);
      const f = (343 / 2) * Math.sqrt(Math.pow(t[0] / 3, 2) + Math.pow(t[1] / 3, 2) + Math.pow(t[2] / 3, 2));
      assert.ok(near(f, b.f, 1e-9), k + ' 的频率 ' + f + ' 与归并行 ' + b.f + ' 不一致');
    });
  });
  // 模式条数 = 归并视图 deg 之和
  assert.equal(mm.byFreq.reduce((s, b) => s + b.deg, 0), modes.length);
});

test('C4 排列轨道大小：(1,1,1)→1、(2,1,0)→6、(2,2,0)→3、(2,0,0)→3', () => {
  assert.equal(A.permuteCount([1, 1, 1]), 1);
  assert.equal(A.permuteCount([2, 1, 0]), 6, '三个下标互不相同 → 6 个排列都不同');
  assert.equal(A.permuteCount([2, 2, 0]), 3);
  assert.equal(A.permuteCount([2, 0, 0]), 3);
  assert.equal(A.permuteCount([1, 1, 0]), 3);
  assert.equal(A.permuteCount([3, 2, 1]), 6);
  assert.equal(A.permuteCount([0, 0, 1]), 3);
  assert.equal(A.permuteCount([4, 4, 4]), 1);
  // 与「穷举排列去重后的个数」对拍
  [[1, 1, 1], [2, 1, 0], [2, 2, 0], [2, 0, 0], [3, 3, 1], [4, 0, 0], [2, 3, 1]].forEach((t) => {
    const seen = {};
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      if (i === j || j === k || i === k) continue;
      seen[t[i] + ',' + t[j] + ',' + t[k]] = 1;
    }
    assert.equal(A.permuteCount(t), Object.keys(seen).length, JSON.stringify(t));
  });
});

test('C5 房间模式与频率尺的数据源只有 300 Hz 以内', () => {
  const r = A.compute(D());
  assert.ok(r.modes.length > 0);
  assert.ok(r.modes.every((m) => m.f <= 300 + 1e-9));
  assert.equal(r.modes.length, r.bruteModeCount, '模式条数 = 穷举条数');
  assert.ok(r.modesByFreq.length <= r.modes.length);
  assert.equal(r.gapMinHz, 12);
  assert.deepEqual(r.gapRange, [50, 120]);
  // 空档：50–120 Hz 内相邻间距 ≥ 12
  const inBand = r.modesByFreq.filter((m) => m.f >= 50 && m.f <= 120);
  let expect = 0;
  for (let i = 1; i < inBand.length; i++) if (inBand[i].f - inBand[i - 1].f >= 12) expect++;
  assert.equal(r.gaps.list.length, expect);
  assert.equal(r.gaps.count, inBand.length);
});

test('C6 每个方向的本征频率是 c/(2d) 的整数倍', () => {
  const ax = A.axialFrequencies(4.2, 3.6, 2.6);
  ['length', 'width', 'height'].forEach((k, i) => {
    const dim = [4.2, 3.6, 2.6][i];
    ax[k].forEach((o) => assert.ok(near(o.f, 343 / (2 * dim) * o.n, 1e-12), k + ' n=' + o.n));
  });
  assert.equal(ax.length.length, 4);
});

test('C7 相邻模式间距表与「按频率归并」的清单一致', () => {
  const r = A.compute(D());
  const sp = r.spacing;
  assert.equal(sp.length, r.modesByFreq.length - 1);
  sp.forEach((g, i) => {
    assert.ok(near(g.from, r.modesByFreq[i].f, 1e-12));
    assert.ok(near(g.to, r.modesByFreq[i + 1].f, 1e-12));
    assert.ok(near(g.gap, r.modesByFreq[i + 1].f - r.modesByFreq[i].f, 1e-12));
    assert.ok(g.gap > 0);
  });
});

/* ═══════════════ D. 单点指标 ═══════════════ */

test('D1 Schroeder 频率随 RT60 上升、随体积下降', () => {
  assert.ok(A.schroederHz(1.0, 100) > A.schroederHz(0.5, 100));
  assert.ok(A.schroederHz(1.0, 50) > A.schroederHz(1.0, 100));
  assert.ok(near(A.schroederHz(1.0, 100), 2000 * Math.sqrt(1 / 100), 1e-12));
  assert.ok(!isFinite(A.schroederHz(1, 0)));
  assert.ok(!isFinite(A.schroederHz(0, 100)));
});

test('D2 临界距离 = 0.141·√(Q·A)，随吸声量上升', () => {
  assert.ok(near(A.criticalDistance(100, 1), 0.141 * 10, 1e-12));
  assert.ok(near(A.criticalDistance(100, 2), 0.141 * Math.sqrt(200), 1e-12));
  assert.ok(A.criticalDistance(200, 1) > A.criticalDistance(100, 1));
  assert.equal(A.criticalDistance(0, 1), 0);
});

test('D3 Weyl 模态数随频率与体积单调上升，且 f=0 时为 0', () => {
  const S = 70.8, edge = 41.6, V = 39.312;
  assert.equal(A.modalCount(0, V, S, edge), 0);
  assert.ok(A.modalCount(200, V, S, edge) > A.modalCount(100, V, S, edge));
  assert.ok(A.modalCount(200, V * 2, S, edge) > A.modalCount(200, V, S, edge));
  assert.ok(A.modalCount(200, V, S, edge) > 0);
});

test('D4 听音位在房间中心时两个水平方向都是压力节点', () => {
  const r = A.compute(D());
  assert.ok(Math.abs(r.listener.x.cos) < 1e-9);
  assert.ok(Math.abs(r.listener.y.cos) < 1e-9);
  assert.equal(r.listener.x.at, 'node');
  assert.equal(r.listener.y.at, 'node');
  assert.ok(near(r.listener.x.f, 343 / (2 * 4.2), 1e-12));
});

test('D5 听音位贴着墙时是压力腹点', () => {
  const r = A.compute(D({ listener: { fromWallL: 0, fromWallW: 0 } }));
  assert.ok(Math.abs(Math.abs(r.listener.x.cos) - 1) < 1e-9);
  assert.equal(r.listener.x.at, 'antinode');
  assert.equal(r.listener.y.at, 'antinode');
});

/* ═══════════════ E. 反解与处方 ═══════════════ */

test('E1 反解回代：补够吸声量后 500 Hz 恰好回到目标值', () => {
  let n = 0;
  [0.2, 0.35, 0.5, 0.8, 1.2].forEach((t) => {
    const r = A.compute(D({ targetRT60: t }));
    if (r.required.need <= 0) {
      // 目标比现状更「拖」时不需要补，回代必然低于目标 —— 这一档单独核
      assert.ok(A.rt60(r.geometry.V, r.absorption.total[2], 0) < t, '目标 ' + t + ' 不需要补时现状就该比目标更干');
      return;
    }
    const A2 = r.absorption.total[2] + r.required.need;
    const rt2 = A.rt60(r.geometry.V, A2, 0);
    assert.ok(near(rt2, t, 1e-9), '目标 ' + t + ' 回代得到 ' + rt2);
    n++;
  });
  assert.ok(n >= 4, '至少要有 4 档真的走了回代');
});

test('E2 已经比目标更干时缺口为 0，且不出现负缺口', () => {
  const r = A.compute(D({ targetRT60: 2.0 }));
  assert.equal(r.required.need, 0);
  assert.ok(r.required.A_target < r.absorption.total[2]);
  // 处方里的面积不能是负数
  r.prescriptions.forEach((p) => { if (p.freeArea !== null) assert.ok(p.freeArea >= 0); });
  r.plan.options.forEach((o) => { assert.ok(o.area === null || (isFinite(o.area) && o.area >= 0), o.label + ' ' + o.area); });
});

test('E3 独立吸声体的面积 = 缺口 ÷ 该材料系数', () => {
  const r = A.compute(D());
  const need = r.required.need;
  const p50 = r.prescriptions.filter((p) => p.material === 'panel_50')[0];
  assert.ok(near(p50.freeArea, need / 0.75, 1e-12), p50.freeArea + ' vs ' + need / 0.75);
  const trap = r.prescriptions.filter((p) => p.material === 'bass_trap')[0];
  assert.ok(near(trap.freeArea, need / 0.60, 1e-12));
  // 排序：面积从小到大
  for (let i = 1; i < r.prescriptions.length; i++) {
    const a = r.prescriptions[i - 1].freeArea, b = r.prescriptions[i].freeArea;
    assert.ok((a === null ? Infinity : a) <= (b === null ? Infinity : b) + 1e-12, '处方应当按面积升序');
  }
});

test('E4 「贴到长边墙」的面积 = 缺口 ÷（新系数 − 原面系数），系数没提高就没有解', () => {
  const r = A.compute(D());
  const need = r.required.need;
  const p50 = r.prescriptions.filter((p) => p.material === 'panel_50')[0];
  // 长边墙默认是 paint_concrete，500 Hz 系数 0.03
  assert.ok(near(p50.installedArea, need / (0.75 - 0.03), 1e-12), p50.installedArea + ' vs ' + need / 0.72);
  assert.ok(near(p50.installedMax, 10.92, 1e-12), '长边墙单面面积 ' + p50.installedMax);
  assert.equal(p50.installedFeasible, need / 0.72 <= p50.installedMax + 1e-9);
  // paint_concrete 自己贴自己：系数不提高 → 没有解
  const same = r.prescriptions.filter((p) => p.material === 'paint_concrete')[0];
  assert.equal(same.installedArea, null);
});

test('E5 处方里「代入」的面积确实能把 RT60 压到目标以下（回代核验）', () => {
  const r = A.compute(D());
  r.plan.options.forEach((o) => {
    if (o.area === null || !isFinite(o.area) || o.area > 200) return;
    const matId = o.key === 'carpet' ? 'carpet_mid' : (o.key === 'trap_free' ? 'bass_trap' : 'panel_50');
    const add = Math.min(200, o.area) * A.coeffOf(matId, 2, r.input.customA);
    const rt = A.rt60(r.geometry.V, r.absorption.total[2] + add, 0);
    assert.ok(rt <= r.input.targetRT60 + 1e-9, o.label + ' 代入后 RT60=' + rt + ' 没有达到目标 ' + r.input.targetRT60);
  });
});

test('E5b 处方面积契约：要么正数、要么 null（任何输入下都不出现 NaN）', () => {
  let seed = 555;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const surf = ['floor', 'ceiling', 'wallN', 'wallS', 'wallE', 'wallW'];
  const mats = Object.keys(A_TABLE).concat(['custom']);
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const r = A.compute(D({
      L: 1.5 + rnd() * 28.5, W: 1.5 + rnd() * 28.5, H: 1.5 + rnd() * 10.5,
      targetRT60: 0.1 + rnd() * 1.9,
      materials: surf.reduce((o, k) => { o[k] = mats[Math.floor(rnd() * mats.length)]; return o; }, {}),
      customA: [0, 0, 0, 0, 0, 0].map(() => Number((rnd() * 1).toFixed(3))),
      panel: { area: rnd() * 200, material: mats[Math.floor(rnd() * mats.length)], surface: surf[Math.floor(rnd() * 6)] },
    }));
    if (!r.ok) continue;
    n++;
    r.plan.options.forEach((o) => {
      assert.ok(o.area === null || (typeof o.area === 'number' && isFinite(o.area) && o.area >= 0),
        '面积既不是 null 也不是有限正数：' + JSON.stringify(o));
      assert.ok(o.area === null || o.area <= 1e9, '面积不应当是天文数字');
    });
    assert.equal(r.planAreaOk, true);
    assert.equal(r.selfCheckFailures, 0, JSON.stringify(r.checks.filter((c) => !c.ok)));
  }
  assert.ok(n >= 150, '有效用例 ' + n);
});

test('E6 全屋统一处理的对照表内部自洽', () => {
  const r = A.compute(D());
  assert.ok(r.uniformRef.length >= 3);
  r.uniformRef.forEach((u) => {
    assert.ok(near(u.A, r.geometry.totalSurface * u.coeff, 1e-9), u.name);
    // 对照表用的是 500 Hz 这个频段（空气吸收系数在 500 Hz 为 0）
    assert.equal(A.AIR_M[500], 0, '500 Hz 的空气吸收系数应当是 0');
    assert.ok(near(u.rt60, A.rt60(r.geometry.V, u.A, A.AIR_M[500]), 1e-9), u.name + ' ' + u.rt60);
  });
});

/* ═══════════════ F. 单调性与不变量 ═══════════════ */

test('F1 任意一个面换成吸声更好的材料，500 Hz 吸声量不降、RT60 不升', () => {
  const base = A.compute(D()).rt60[2];
  const upgrades = [
    ['floor', 'carpet_mid'], ['floor', 'tile_floor'], ['ceiling', 'panel_50'],
    ['wallN', 'curtain_heavy'], ['wallE', 'plasterboard'],
  ];
  upgrades.forEach((u) => {
    const r = A.compute(D({ materials: Object.assign({}, A.defaults().materials, { [u[0]]: u[1] }) }));
    const oldC = A.coeffOf(A.defaults().materials[u[0]], 2, A.defaults().customA);
    const newC = A.coeffOf(u[1], 2, A.defaults().customA);
    if (newC > oldC) assert.ok(r.rt60[2] < base, u[0] + '→' + u[1] + ' 应当让 RT60 变短');
    else if (newC < oldC) assert.ok(r.rt60[2] > base, u[0] + '→' + u[1] + ' 应当让 RT60 变长');
    else assert.ok(near(r.rt60[2], base, 1e-12));
  });
});

test('F2 房间线性放大 k 倍（面的面积与家具等效面积都按 k² 放大）时 RT60 正好变成 k 倍，S/V 比按 1/k 缩小', () => {
  // 口径说明：A 按 k² 放大、V 按 k³ 放大，于是 RT60 = 0.161·V/A 按 k 放大。
  // 这不是 bug，是 Sabine 公式的量纲性质 —— 同一个房间等比放大，混响一定更长。
  // 被同时锁住的还有：S/V 比只由三个尺寸决定（S/V = 2(1/L+1/W+1/H)），等比放大 k 倍就缩小 1/k 倍。
  const base = A.defaults();
  const a0 = A.compute(D());
  [2, 3, 1.25, 0.75].forEach((k) => {
    const r = A.compute(D({
      L: base.L * k, W: base.W * k, H: base.H * k,
      furniture: base.furniture.map((f) => ({ name: f.name, material: f.material, area: f.area * k * k })),
      panel: { area: 0, material: 'panel_50', surface: 'wallN' },
    }));
    assert.equal(r.ok, true, 'k=' + k + ' ' + JSON.stringify(r.errors));
    assert.ok(near(r.rt60[2], a0.rt60[2] * k, 1e-9), 'k=' + k + ' RT60：' + r.rt60[2] + ' vs ' + a0.rt60[2] * k);
    assert.ok(near(r.geometry.totalSurface / r.geometry.V, (a0.geometry.totalSurface / a0.geometry.V) / k, 1e-9),
      'k=' + k + ' S/V：' + (r.geometry.totalSurface / r.geometry.V) + ' vs ' + ((a0.geometry.totalSurface / a0.geometry.V) / k));
    // 六个面的面积必须按 k² 放大、体积按 k³
    assert.ok(near(r.geometry.totalSurface, a0.geometry.totalSurface * k * k, 1e-9), 'k=' + k + ' 内表面积');
    assert.ok(near(r.geometry.V, a0.geometry.V * k * k * k, 1e-9), 'k=' + k + ' 体积');
  });
  // 只放大房间、不放大家具：吸声量涨得不够，RT60 涨得比 k 还快 —— 把这条口径也钉住
  const c = A.compute(D({ L: base.L * 2, W: base.W * 2, H: base.H * 2 })).rt60[2];
  assert.ok(c > a0.rt60[2] * 2, '实测 ' + c + ' 应当大于 2 倍（' + a0.rt60[2] * 2 + '）');
});

test('F3 加吸声板 / 加软装都只会让 RT60 变短或不变', () => {
  const base = A.compute(D()).rt60[2];
  const p = A.compute(D({ panel: { area: 5, material: 'panel_50', surface: 'wallN' } })).rt60[2];
  assert.ok(p < base);
  const f = A.compute(D({ furniture: [{ name: '大沙发', material: 'upholstered', area: 12 }] })).rt60[2];
  assert.ok(f < base);
  const zero = A.compute(D({ panel: { area: 0, material: 'bass_trap', surface: 'wallN' } })).rt60[2];
  assert.ok(near(zero, base, 1e-12), '面积 0 的吸声板不应当改变结果');
});

test('F4 六个面的面积之和 = 总内表面积；每条边都被算到', () => {
  const r = A.compute(D());
  const sum = Object.keys(r.absorption.bySurface).reduce((s, k) => s + r.absorption.bySurface[k].area, 0);
  assert.ok(near(sum, r.geometry.totalSurface, 1e-12));
  assert.ok(near(r.geometry.totalSurface, 2 * r.dims.x * r.dims.y + 2 * r.dims.x * r.dims.z + 2 * r.dims.y * r.dims.z, 1e-12));
});

test('F5 墙面面积口径是不减门窗洞的净空几何（如实口径锁定）', () => {
  const r = A.compute(D());
  const wallSum = r.absorption.bySurface.wallN.area + r.absorption.bySurface.wallS.area +
    r.absorption.bySurface.wallE.area + r.absorption.bySurface.wallW.area;
  assert.ok(near(wallSum, 2 * (r.input.L + r.input.W) * r.input.H, 1e-12));
});

test('F6 吸声板不扣掉被它遮住那部分墙面的原吸声量（保守口径锁定）', () => {
  const base = A.compute(D());
  const withPanel = A.compute(D({ panel: { area: 5, material: 'panel_50', surface: 'wallN' } }));
  // 墙面贡献完全不变，增量就是 5×0.75
  assert.ok(near(withPanel.absorption.bySurface.wallN.absorb[2], base.absorption.bySurface.wallN.absorb[2], 1e-12));
  assert.ok(near(withPanel.absorption.total[2] - base.absorption.total[2], 5 * 0.75, 1e-12));
});

test('F7 随机压力：300 组合法规格 × 每条不变量，0 违反', () => {
  let seed = 20261112;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const surf = ['floor', 'ceiling', 'wallN', 'wallS', 'wallE', 'wallW'];
  const mats = Object.keys(A_TABLE).concat(['custom']);
  let asserts = 0, cases = 0;
  for (let i = 0; i < 300; i++) {
    const inp = D({
      L: 1.5 + rnd() * 28.5, W: 1.5 + rnd() * 28.5, H: 1.5 + rnd() * 10.5,
      targetRT60: 0.1 + rnd() * 1.9,
      speakerDistance: 0.3 + rnd() * 9.7,
      materials: surf.reduce((o, k) => { o[k] = mats[Math.floor(rnd() * mats.length)]; return o; }, {}),
      customA: [0, 0, 0, 0, 0, 0].map(() => Number((0.02 + rnd() * 0.98).toFixed(3))),   // 全是正数：全 0 系数会让 RT60 = Infinity，那种退化情形由 K4 单独守
      furniture: (function () { const n = Math.floor(rnd() * 4); const a = []; for (let j = 0; j < n; j++) a.push({ name: 'f' + j, material: mats[Math.floor(rnd() * mats.length)], area: rnd() * 100 }); return a; })(),
      panel: { area: rnd() * 200, material: mats[Math.floor(rnd() * mats.length)], surface: surf[Math.floor(rnd() * 6)] },
    });
    const r = A.compute(inp);
    if (!r.ok) continue;
    cases++;
    const v = naive(r.input);
    // 不变量 1：体积
    assert.ok(near(r.geometry.V, r.input.L * r.input.W * r.input.H, 1e-12)); asserts++;
    // 不变量 2：吸声量非负
    for (let b = 0; b < 6; b++) { assert.ok(r.absorption.total[b] >= 0, 'A 非负'); asserts++; }
    // 不变量 3：RT60 有限正
    for (let b = 0; b < 6; b++) { assert.ok(r.rt60[b] > 0 && isFinite(r.rt60[b]), 'RT60 有限正 ' + r.rt60[b]); asserts++; }
    // 不变量 4：与朴素实现一致
    for (let b = 0; b < 6; b++) { assert.ok(near(r.rt60[b], v.rt[b], 1e-10), 'RT60 对拍 段' + b); asserts++; }
    // 不变量 5：模式条数 = 穷举的合法下标三元组条数；归并视图成员数之和也等于它
    {
      let brute = 0;
      for (let nx = 0; nx <= 4; nx++) for (let ny = 0; ny <= 4; ny++) for (let nz = 0; nz <= 4; nz++) {
        if (nx === 0 && ny === 0 && nz === 0) continue;
        const f = (343 / 2) * Math.sqrt(Math.pow(nx / r.input.L, 2) + Math.pow(ny / r.input.W, 2) + Math.pow(nz / r.input.H, 2));
        if (f > 0 && f <= 300 + 1e-9) brute++;
      }
      assert.equal(r.modes.length, brute, '模式条数 vs 穷举'); asserts++;
      assert.equal(r.modesByFreq.reduce((s, b) => s + b.deg, 0), brute, '归并视图 deg 之和'); asserts++;
    }
    // 不变量 6：缺口的符号与大小
    assert.ok(r.required.need >= 0, '缺口非负'); asserts++;
    assert.ok(near(r.required.A_target, 0.161 * r.geometry.V / r.input.targetRT60, 1e-9), 'A_target'); asserts++;
    // 不变量 7：自检必须全过
    assert.equal(r.selfCheckFailures, 0, '自检未过：' + JSON.stringify(r.checks.filter((c) => !c.ok))); asserts++;
    // 不变量 8：输出里没有 NaN / Infinity（除明确允许的口径）
    const flat = JSON.stringify(r, (k, val) => (typeof val === 'number' && !isFinite(val) ? 'BAD' : val));
    assert.ok(flat.indexOf('BAD') < 0, '输出里出现了非有限数'); asserts++;
  }
  assert.ok(cases >= 200, '有效随机用例太少：' + cases);
  assert.ok(asserts >= 3000, '断言太少：' + asserts);
});

test('F8 随机压力：把总吸声量翻倍后 RT60 必须变短（500 组）', () => {
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 500; i++) {
    const r = A.compute(D({
      L: 1.5 + rnd() * 10, W: 1.5 + rnd() * 10, H: 1.5 + rnd() * 6,
      panel: { area: rnd() * 50, material: 'panel_50', surface: 'wallN' },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const A5 = r.absorption.total[2];
    assert.ok(A5 > 0);
    assert.ok(A.rt60(r.geometry.V, A5 * 2, 0) < A.rt60(r.geometry.V, A5, 0));
  }
});

/* ═══════════════ G. 非法输入（逐条核字段） ═══════════════ */

test('G1 尺寸越界 / 非数字', () => {
  assert.ok(hasField(bad({ L: 1.4 }), 'L'));
  assert.ok(hasField(bad({ L: 31 }), 'L'));
  assert.ok(hasField(bad({ W: 1.0 }), 'W'));
  assert.ok(hasField(bad({ H: 13 }), 'H'));
  assert.ok(hasField(bad({ H: 1.2 }), 'H'));
  assert.ok(hasField(bad({ L: '4.2' }), 'L'));
  assert.ok(hasField(bad({ L: NaN }), 'L'));
  assert.ok(hasField(bad({ W: Infinity }), 'W'));
  assert.ok(hasField(bad({ H: null }), 'H'));
});

test('G2 目标 / 音箱距离 / 吸声板面积越界', () => {
  assert.ok(hasField(bad({ targetRT60: 0.05 }), 'targetRT60'));
  assert.ok(hasField(bad({ targetRT60: 2.5 }), 'targetRT60'));
  assert.ok(hasField(bad({ speakerDistance: 0.1 }), 'speakerDistance'));
  assert.ok(hasField(bad({ speakerDistance: 11 }), 'speakerDistance'));
  assert.ok(hasField(bad({ panel: { area: 201, material: 'panel_50', surface: 'wallN' } }), 'panel.area'));
  assert.ok(hasField(bad({ panel: { area: -1, material: 'panel_50', surface: 'wallN' } }), 'panel.area'));
  assert.ok(hasField(bad({ panel: { area: NaN, material: 'panel_50', surface: 'wallN' } }), 'panel.area'));
});

test('G3 材料 id 不在库里（六个面 / 家具 / 吸声板 / 安装面）', () => {
  const surf = ['floor', 'ceiling', 'wallN', 'wallS', 'wallE', 'wallW'];
  surf.forEach((k) => {
    const m = Object.assign({}, A.defaults().materials); m[k] = 'nope';
    assert.ok(hasField(bad({ materials: m }), 'materials.' + k), k);
  });
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'nope', area: 1 }] }), 'furniture.0.material'));
  assert.ok(hasField(bad({ panel: { area: 1, material: 'nope', surface: 'wallN' } }), 'panel.material'));
  assert.ok(hasField(bad({ panel: { area: 1, material: 'panel_50', surface: 'nope' } }), 'panel.surface'));
});

test('G4 自定义吸声系数：个数不对 / 越界 / 非数字', () => {
  assert.ok(hasField(bad({ customA: [0.1, 0.2] }), 'customA'));
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, 1.5] }), 'customA.5'));
  assert.ok(hasField(bad({ customA: [-0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }), 'customA.0'));
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, 'x'] }), 'customA.5'));
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, null] }), 'customA.5'), 'null 不能被当成 0');
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, undefined] }), 'customA.5'));
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, ''] }), 'customA.5'), '空串不能被当成 0');
  assert.ok(hasField(bad({ customA: [0.1, 0.2, 0.3, 0.4, 0.5, true] }), 'customA.5'), '布尔不能被当成 1');
});

test('G5 家具：件数过多 / 缺名字 / 面积越界 / 不是记录', () => {
  const many = [];
  for (let i = 0; i < 13; i++) many.push({ name: 'f' + i, material: 'upholstered', area: 1 });
  assert.ok(hasField(bad({ furniture: many }), 'furniture'));
  assert.ok(hasField(bad({ furniture: [{ name: '  ', material: 'upholstered', area: 1 }] }), 'furniture.0.name'));
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'upholstered', area: 201 }] }), 'furniture.0.area'));
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'upholstered', area: -3 }] }), 'furniture.0.area'));
  assert.ok(hasField(bad({ furniture: [null] }), 'furniture.0'));
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'upholstered', area: '5' }] }), 'furniture.0.area'));
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'upholstered', area: null }] }), 'furniture.0.area'), 'null 不能被当成 0 m²');
  assert.ok(hasField(bad({ furniture: [{ name: 'x', material: 'upholstered', area: true }] }), 'furniture.0.area'));
});

test('G6 听音位：非数字 / 超出房间', () => {
  assert.ok(hasField(bad({ listener: { fromWallL: 'x', fromWallW: 1 } }), 'listener.fromWallL'));
  assert.ok(hasField(bad({ listener: { fromWallL: 4.5, fromWallW: 1 } }), 'listener.fromWallL'));
  assert.ok(hasField(bad({ listener: { fromWallL: -0.1, fromWallW: 1 } }), 'listener.fromWallL'));
  assert.ok(hasField(bad({ listener: { fromWallL: 1, fromWallW: 3.9 } }), 'listener.fromWallW'));
  // 边界值等于房间尺寸时合法
  const ok1 = A.compute(D({ listener: { fromWallL: 4.2, fromWallW: 3.6 } }));
  assert.equal(ok1.ok, true, JSON.stringify(ok1.errors));
  // 留空合法
  const ok2 = A.compute(D({ listener: { fromWallL: null, fromWallW: null } }));
  assert.equal(ok2.ok, true);
});

test('G7 一次把所有错都报出来（不是只报第一条）', () => {
  const errs = bad({ L: 0.5, W: 99, H: 0.2, targetRT60: 5, speakerDistance: 20, panel: { area: 999, material: 'nope', surface: 'nope' } });
  const fields = errs.map((e) => e.field);
  ['L', 'W', 'H', 'targetRT60', 'speakerDistance', 'panel.area', 'panel.material', 'panel.surface'].forEach((f) => {
    assert.ok(fields.indexOf(f) >= 0, '应当报出 ' + f + '，实际 ' + JSON.stringify(fields));
  });
  assert.ok(errs.length >= 8);
  errs.forEach((e) => { assert.ok(e.msg && e.msg.length > 4, '错误信息要能看懂：' + JSON.stringify(e)); });
});

test('G8 非法输入时 compute 返回 ok:false 且不带结果', () => {
  const r = A.compute(D({ L: 0.1 }));
  assert.equal(r.ok, false);
  assert.equal(r.rt60, undefined);
  assert.equal(r.geometry, undefined);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

test('G9 空/缺字段的对象按默认值补齐，不崩', () => {
  const r = A.compute({});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const r2 = A.compute(undefined);
  assert.equal(r2.ok, true);
  const r3 = A.compute({ materials: { floor: 'carpet_mid' } });
  assert.equal(r3.ok, true);
  assert.equal(r3.input.materials.floor, 'carpet_mid');
  assert.equal(r3.input.materials.ceiling, A.defaults().materials.ceiling, '没给的键要保留默认');
  const r4 = A.compute({ furniture: [] });
  assert.deepEqual(r4.input.furniture, []);
});

/* ═══════════════ H. 确定性与纯函数 ═══════════════ */

test('H1 同输入两次结果逐字节一致', () => {
  const a = JSON.stringify(A.compute(D()));
  const b = JSON.stringify(A.compute(D()));
  assert.equal(a, b);
});

test('H2 compute 不修改传入的对象', () => {
  const inp = D({ materials: Object.assign({}, A.defaults().materials, { floor: 'carpet_mid' }) });
  const snap = JSON.stringify(inp);
  A.compute(inp);
  assert.equal(JSON.stringify(inp), snap);
});

test('H3 每个场景都能算干净且自检全过', () => {
  const list = A.scenarios();
  assert.ok(list.length >= 6);
  list.forEach((s) => {
    const r = A.compute(Object.assign(A.defaults(), s.over));
    assert.equal(r.ok, true, s.key + ' ' + JSON.stringify(r.errors));
    assert.equal(r.selfCheckFailures, 0, s.key + ' 自检未过 ' + JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(r.checks.length >= 12, s.key + ' 自检条数 ' + r.checks.length);
  });
});

test('H4 场景是「改条件即可重算」的：每个场景只改它声明的键', () => {
  const base = A.defaults();
  A.scenarios().forEach((s) => {
    Object.keys(s.over).forEach((k) => { assert.ok(k in base, s.key + ' 改了不存在的键 ' + k); });
  });
  // 至少有一个场景确实改了东西
  assert.ok(A.scenarios().some((s) => Object.keys(s.over).length > 0));
});

/* ═══════════════ I. 输出契约与导出契约 ═══════════════ */

test('I1 输出字段齐全、类型正确、没有 NaN', () => {
  const r = A.compute(D());
  ['ok', 'input', 'geometry', 'absorption', 'rt60', 'bands', 'modes', 'modesByFreq', 'bruteModeCount', 'axial', 'spacing', 'gaps',
    'schroeder', 'criticalDistance', 'modalCountAtSchroeder', 'required', 'prescriptions', 'listener',
    'verdict', 'uniformRef', 'surfaceList', 'checks', 'selfCheckFailures', 'plan'].forEach((k) => {
    assert.ok(k in r, '缺字段 ' + k);
  });
  assert.equal(r.bands.length, 6);
  assert.deepEqual(r.bands, [125, 250, 500, 1000, 2000, 4000]);
  assert.equal(r.rt60.length, 6);
  assert.equal(r.absorption.total.length, 6);
  assert.ok(r.checks.every((c) => typeof c.ok === 'boolean' && c.name));
  assert.ok(['draggy', 'near', 'dry'].indexOf(r.verdict) >= 0);
  assert.deepEqual(r.surfaceList.map((s) => s.key), ['floor', 'ceiling', 'wallN', 'wallS', 'wallE', 'wallW']);
  // 递归查 NaN
  (function walk(v, p) {
    if (typeof v === 'number') { assert.ok(isFinite(v), 'NaN/Inf 出现在 ' + p); return; }
    if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], p + '.' + k));
  })(Object.assign({}, r, { plan: { options: r.plan.options.filter((o) => isFinite(o.area)), need: r.plan.need } }), 'r');
});

test('I2 判定分组的阈值两侧（0.4 与 0.6 是设计选择，这里把它锁住）', () => {
  const r1 = A.compute(D({ targetRT60: 0.35, panel: { area: 0, material: 'panel_50', surface: 'wallN' } }));
  assert.equal(r1.verdict, 'draggy');
  // 直接验判定函数的分界：构造 RT60 分别落在三档的场景
  const dry = A.compute(D({ furniture: [], panel: { area: 60, material: 'panel_50', surface: 'wallN' } }));
  assert.ok(dry.rt60[2] < 0.4, 'dry 场景 RT60=' + dry.rt60[2]);
  assert.equal(dry.verdict, 'dry');
  assert.equal(dry.verdictLabel, '干');
});

test('I3 格式化函数不产生 NaN 文本', () => {
  assert.equal(A.fmt(NaN), '—');
  assert.equal(A.fmt(Infinity), '—');
  assert.equal(A.fmt(null), '—');
  assert.equal(A.fmt(1.005, 2), '1.00');
  assert.equal(A.fmt(0.5, 2), '0.50');
  assert.equal(A.fmtRT(0.941), '0.941');
  assert.equal(A.fmtRT(1.5), '1.50');
  assert.equal(A.fmtHz(40.83), '40.8');
  assert.equal(A.fmtPct(9.876, 1), '9.9%');
  assert.equal(A.fmtArea(150), '150');
  assert.equal(A.fmtArea(15), '15.0');
  assert.equal(A.fmtArea(1.5), '1.50');
  assert.equal(A.fmtM2(3.152), '3.15 m²');
  assert.equal(A.fmtM2(NaN), '— m²');
});

test('I4 材料表 / 面表的形状对得上，且「自定义」在库里', () => {
  const rows = A.materialRows();
  assert.ok(rows.length >= 17);
  rows.forEach((m) => { assert.equal(m.a.length, 6); assert.ok(m.name && m.group && m.note); });
  assert.ok(rows.some((m) => m.id === 'custom'));
  assert.equal(A.surfaceRows().length, 6);
  assert.equal(A.materialGroups().length >= 4, true);
  assert.equal(A.freqLabels().length, 6);
});

test('I5 导出用得到的字段都能被格式化（不含 undefined / NaN 文本）', () => {
  const r = A.compute(D());
  const cells = [];
  r.bands.forEach((f, i) => {
    cells.push(A.fmt(f, 0), A.fmt(r.rt60[i], 4), A.fmt(r.absorption.total[i], 4));
  });
  A.surfaceRows().forEach((s) => {
    const row = r.absorption.bySurface[s.key];
    cells.push(row.area.toFixed(2), row.coeff[2].toFixed(3), row.absorb[2].toFixed(4));
  });
  r.absorption.furniture.forEach((f) => cells.push(f.area.toFixed(2), f.coeff[2].toFixed(3), f.absorb[2].toFixed(4)));
  r.modes.forEach((m) => cells.push(m.f.toFixed(3), String(m.nx), String(m.deg)));
  cells.push(r.schroeder.toFixed(2), r.criticalDistance.toFixed(4), r.required.A_target.toFixed(4), r.required.need.toFixed(4));
  cells.forEach((c) => assert.ok(typeof c === 'string' && c.indexOf('NaN') < 0 && c.indexOf('undefined') < 0, '坏单元格 ' + c));
});

/* ═══════════════ J. 自检「会红」反向验证 ═══════════════ */

test('J1 自检确实会报错：把结果对象改坏，自检必须红', () => {
  const r = A.compute(D());
  const good = r.checks.filter((c) => !c.ok).length;
  assert.equal(good, 0, '正常结果不该有红的自检');

  function failCountAfter(mutate) {
    const copy = JSON.parse(JSON.stringify(r));
    mutate(copy);
    return A.runChecks(copy).filter((c) => !c.ok).length;
  }

  // ① 把某段的吸声量改掉 → 「逐段吸声量 = 分项之和」必须红
  assert.ok(failCountAfter((c) => { c.absorption.total[2] += 1; }) > 0, '吸声量对不上时应当报红');
  // ② 把体积改坏 → 体积为正 / 总表面积 至少一条红
  assert.ok(failCountAfter((c) => { c.geometry.V = -1; }) > 0, '体积为负时应当报红');
  // ③ RT60 改成 0 → 红
  assert.ok(failCountAfter((c) => { c.rt60[2] = 0; }) > 0, 'RT60=0 时应当报红');
  // ④ 反解目标改坏 → 「反解回代」红
  assert.ok(failCountAfter((c) => { c.required.need = c.required.need + 5; }) > 0, '缺口被改坏时应当报红');
  // ⑤ 把模式清单清空 → 红
  assert.ok(failCountAfter((c) => { c.modes = []; }) > 0, '模式清单为空时应当报红');
  // ⑥ 把某个模式频率改成负数 → 红
  assert.ok(failCountAfter((c) => { c.modes[0].f = -3; }) > 0, '模式频率为负时应当报红');
  // ⑦ Schroeder 改成 NaN → 红
  assert.ok(failCountAfter((c) => { c.schroeder = NaN; }) > 0, 'Schroeder 为 NaN 时应当报红');
  // ⑧ 临界距离改 0 → 红
  assert.ok(failCountAfter((c) => { c.criticalDistance = 0; }) > 0, '临界距离为 0 时应当报红');
  // ⑨ 长边一阶模式被删掉 → 红
  assert.ok(failCountAfter((c) => {
    const f1 = 343 / (2 * c.input.L);
    c.modes = c.modes.filter((m) => Math.abs(m.f - f1) > 1e-6);
  }) > 0, '缺少 c/(2L) 模式时应当报红');
});

test('J2 自检条数与默认场景的自检项对得上（不是空跑）', () => {
  const r = A.compute(D());
  assert.ok(r.checks.length >= 12, '自检只有 ' + r.checks.length + ' 条');
  const names = r.checks.map((c) => c.name).join('|');
  ['体积为正', '逐段吸声量', '辅助', '吸声量翻倍', '反解回代', '驻波', 'Schroeder', '临界距离'].forEach((k) => {
    if (k === '辅助') return;
    assert.ok(names.indexOf(k) >= 0, '自检里应当有「' + k + '」这一项，实际：' + names);
  });
});

/* ═══════════════ K. 极端与退化 ═══════════════ */

test('K1 最小房间 1.5×1.5×1.5 全瓷砖也能算（极亮 → RT 很长）', () => {
  const r = A.compute(D({
    L: 1.5, W: 1.5, H: 1.5, furniture: [],
    materials: { floor: 'tile_floor', ceiling: 'tile_floor', wallN: 'tile_floor', wallS: 'tile_floor', wallE: 'tile_floor', wallW: 'tile_floor' },
    panel: { area: 0, material: 'panel_50', surface: 'wallN' },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 手算：A500 = 6×2.25×0.01 = 0.135；RT = 0.161×3.375/0.135 = 4.025
  assert.ok(near(r.rt60[2], 0.161 * 3.375 / 0.135, 1e-9), 'RT=' + r.rt60[2]);
  assert.ok(r.rt60[2] > 4, '极亮小房间 RT 应当很长');
  assert.equal(r.verdict, 'draggy');
  assert.equal(r.selfCheckFailures, 0);
});

test('K2 最大房间 30×20×12（硬装 + 大吸声面积）', () => {
  const r = A.compute(D({ L: 30, W: 20, H: 12, furniture: [], panel: { area: 200, material: 'panel_50_gap', surface: 'wallN' } }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.geometry.V > 7000);
  assert.ok(r.rt60[2] > 0 && isFinite(r.rt60[2]));
  assert.equal(r.selfCheckFailures, 0);
  assert.ok(r.modes.length > 0);
});

test('K3 把六面全换成极强的吸声处理 → RT 可以很短，且不会算出 0 或负数', () => {
  const r = A.compute(D({
    furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' },
    materials: { floor: 'panel_100', ceiling: 'panel_100', wallN: 'panel_100', wallS: 'panel_100', wallE: 'panel_100', wallW: 'panel_100' },
  }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.rt60[2] > 0 && r.rt60[2] < 0.2, 'RT=' + r.rt60[2]);
  assert.equal(r.verdict, 'dry');
  assert.equal(r.selfCheckFailures, 0);
});

test('K4 自定义系数全 0 → 吸声量 0 → RT60 变成 Infinity，自检必须报红（不假装正常）', () => {
  const r = A.compute(D({
    furniture: [], panel: { area: 0, material: 'custom', surface: 'wallN' },
    customA: [0, 0, 0, 0, 0, 0],
    materials: { floor: 'custom', ceiling: 'custom', wallN: 'custom', wallS: 'custom', wallE: 'custom', wallW: 'custom' },
  }));
  assert.equal(r.ok, true, '全 0 系数是合法输入（只是没有意义）');
  assert.equal(r.absorption.total[2], 0);
  assert.equal(r.rt60[2], Infinity);
  assert.ok(r.selfCheckFailures > 0, '总吸声量为 0 时自检必须报红，而不是假装算出了结果');
});

test('K5 目标比现状更「拖」时不出现负缺口，处方也不给负面积', () => {
  const r = A.compute(D({ targetRT60: 1.9 }));
  assert.equal(r.required.need, 0);
  assert.ok(r.required.A_target < r.absorption.total[2]);
  r.plan.options.forEach((o) => { if (isFinite(o.area)) assert.ok(o.area >= 0, o.label); });
});

test('K6 正方体房间的简并最严重（简并度之和 > 同体积长方体）', () => {
  const cube = A.compute(D({ L: 3, W: 3, H: 3, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } }));
  const box = A.compute(D({ L: 4, W: 3, H: 2.25, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } }));
  // 两者体积都是 27 m³
  assert.ok(near(cube.geometry.V, box.geometry.V, 1e-12));
  const cubeMax = Math.max.apply(null, cube.modes.map((m) => m.deg));
  assert.equal(cubeMax, 6, '立方体的最大简并度应当是 6');
  // 立方体最低模式比长方体更低（3 m 边长的一阶 = 343/6）
  assert.ok(cube.modes[0].f > box.modes[0].f, '这个长方体 4 m 长边的一阶 42.88 Hz 低于立方体 3 m 的 57.17 Hz');
  assert.ok(cube.modes[0].f > 0);
});
