/* 房间的混响时间 · 核心引擎（纯函数，浏览器与 node 通用）
 *
 * 一句话：把房间的长宽高和六个面的材料填进去，算出这个房间会把声音拖多久（各频段混响时间）、
 *         低频在哪些频率上堆起来（驻波）、要贴多少吸声材料才能把混响压到目标值。
 *
 * 口径与假设全部写在页面上（也在 需求与调研.md §3 里）：本引擎不联网、不内置任何产品参数、
 * 不评价任何器材、不给选购建议、不做医学判定。所有数字都由输入与下面的公式算出来。
 *
 * 公式（与页面数字同一套）：
 *   V          = L·W·H
 *   A_band     = Σ(面面积 × 该面材料在该频段的吸声系数) + 家具等效吸声 + 吸声板
 *   RT60_band  = 0.161·V / (A_band + 4·m·V)      （m>0 时附加空气吸收，见 AIR_M）
 *   驻波频率    = (343/2)·√((nx/L)² + (ny/W)² + (nz/H)²)，nx,ny,nz 为非负整数且不全为 0
 *   Schroeder  = 2000·√(RT60_500 / V)
 *   临界距离    = 0.141·√(Q·A)   （Q=1）
 *   A_target   = 0.161·V / RT60_target，需要补的吸声量 = A_target − A_current
 */
(function (root, factory) {
  const A = factory();
  if (typeof module === 'object' && module.exports) module.exports = A;
  if (root) root.AppCore = A;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ─────────────── 常量与口径 ─────────────── */

  const C_SOUND = 343;          // 声速 m/s（20 °C 空气中的常用值）
  const SABINE_K = 0.161;       // Sabine 常数 ≈ 24·ln10/c = 0.1611（c=343）
  const REF_FREQS = [125, 250, 500, 1000, 2000, 4000];
  const MODE_MAX_HZ = 300;      // 驻波清单上限
  const MODE_ORDER = 4;         // 每个方向的阶数上限（含 0）
  const GAP_MIN_HZ = 12;        // 「空档」判定阈值（设计选择，不是标准）
  const GAP_RANGE = [50, 120];  // 空档统计的频段（设计选择）

  /* 空气吸收系数 m（1/m，20 °C / 50% RH 的常用近似值）。
     只对 RT60 起作用、量级很小，单独列出来并注明：没有它时「房间越大 RT60 越长」在小房间里
     会被其它效应掩盖；这里只为把机制写清楚，不代表精确的温湿度模型。 */
  const AIR_M = { 125: 0, 250: 0, 500: 0, 1000: 0, 2000: 0.003, 4000: 0.012 };

  /* 材料库：六段吸声系数是**公开声学资料里的典型区间取值**（同一名称的材料在厚度、衬垫、
     空腔、安装方式不同时差别可以很大）。页面把每个系数都做成可编辑，并明确不代表任何具体产品。
     每行：id / 名称 / 分组 / 六段系数 / 备注（厚度口径） */
  const MATERIALS = [
    { id: 'paint_concrete', name: '乳胶漆混凝土 / 砖墙', group: '硬面', a: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05], note: '硬墙，基本不吸声' },
    { id: 'plaster', name: '抹灰墙面（未处理）', group: '硬面', a: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05], note: '与硬墙同档' },
    { id: 'glass_win', name: '玻璃窗（普通单层）', group: '硬面', a: [0.18, 0.06, 0.04, 0.03, 0.02, 0.02], note: '低频靠薄板共振，中高频反而很亮' },
    { id: 'plasterboard', name: '轻钢龙骨石膏板墙', group: '薄板', a: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09], note: '低频有薄板共振吸收' },
    { id: 'wood_floor', name: '复合木地板（架空）', group: '硬面', a: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07], note: '架空木地板低频比想象中能吸一点' },
    { id: 'tile_floor', name: '瓷砖 / 石材地面', group: '硬面', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02], note: '最亮的硬面' },
    { id: 'vinyl_floor', name: 'PVC / 塑胶地面', group: '硬面', a: [0.02, 0.03, 0.03, 0.03, 0.03, 0.02], note: '薄且贴地，几乎不吸声' },
    { id: 'carpet_thin', name: '薄地毯（贴地）', group: '软面', a: [0.02, 0.04, 0.08, 0.20, 0.35, 0.40], note: '只吸中高频' },
    { id: 'carpet_mid', name: '中厚地毯（带衬垫）', group: '软面', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73], note: '低频仍弱 —— 这是本页要讲的坑之一' },
    { id: 'curtain_thin', name: '单层窗帘（离墙 50 mm）', group: '软面', a: [0.05, 0.06, 0.39, 0.63, 0.70, 0.73], note: '中高频有效' },
    { id: 'curtain_heavy', name: '厚重窗帘（打褶、离墙 100 mm）', group: '软面', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65], note: '离墙越远低频越好' },
    { id: 'upholstered', name: '布艺沙发 / 软包（按投影面积）', group: '软面', a: [0.10, 0.25, 0.45, 0.60, 0.65, 0.70], note: '家具不是只算体积，要按受声面积算' },
    { id: 'panel_25', name: '多孔吸声板 25 mm（贴墙）', group: '吸声处理', a: [0.10, 0.25, 0.55, 0.80, 0.85, 0.85], note: '中高频主力，低频弱' },
    { id: 'panel_50', name: '多孔吸声板 50 mm（贴墙）', group: '吸声处理', a: [0.20, 0.45, 0.75, 0.90, 0.92, 0.92], note: '厚度翻倍，低频明显改善' },
    { id: 'panel_50_gap', name: '多孔吸声板 50 mm（离墙 50 mm 空腔）', group: '吸声处理', a: [0.35, 0.65, 0.85, 0.92, 0.92, 0.90], note: '空腔等于把低频往下推' },
    { id: 'panel_100', name: '多孔吸声板 100 mm', group: '吸声处理', a: [0.45, 0.75, 0.90, 0.95, 0.95, 0.93], note: '再厚，低频更好，收益递减' },
    { id: 'bass_trap', name: '角落低频陷阱（膜 / 亥姆霍兹类）', group: '吸声处理', a: [0.60, 0.72, 0.60, 0.45, 0.40, 0.35], note: '只在低频有效 —— 与多孔板互补' },
    { id: 'custom', name: '自定义吸声系数（下一段由你填）', group: '自定义', a: [0.20, 0.30, 0.40, 0.45, 0.45, 0.45], note: '这是你自己填的值，本页不背书' },
  ];

  const SURFACES = [
    { key: 'floor', name: '地面' },
    { key: 'ceiling', name: '天花' },
    { key: 'wallN', name: '墙 · 长边一侧' },
    { key: 'wallS', name: '墙 · 长边另一侧' },
    { key: 'wallE', name: '墙 · 短边一侧' },
    { key: 'wallW', name: '墙 · 短边另一侧' },
  ];

  const LIMITS = {
    L: [1.5, 30], W: [1.5, 30], H: [1.5, 12],
    targetRT60: [0.10, 2.00],
    panelArea: [0, 200],
    speakerDistance: [0.3, 10],
    furnitureCount: [0, 12],
    // 听音位到墙的距离只受房间尺寸约束，单独判
  };

  const LABEL = {
    verdict: { draggy: '拖', near: '接近', dry: '干' },
    modeKind: { length: '长边方向', width: '短边方向', height: '高度方向' },
  };

  /* ─────────────── 输入 ─────────────── */

  function defaults() {
    return {
      L: 4.2, W: 3.6, H: 2.6,                 // 房间长宽高（m）—— 虚构示例
      materials: {                             // 六个面各用什么材料
        floor: 'wood_floor',
        ceiling: 'paint_concrete',
        wallN: 'paint_concrete', wallS: 'paint_concrete',
        wallE: 'paint_concrete', wallW: 'paint_concrete',
      },
      customA: [0.20, 0.30, 0.40, 0.45, 0.45, 0.45],   // 「自定义」材料用的六段系数
      furniture: [                             // 地面 / 靠墙的大件（等效吸声 = 面积 × 该材料系数）
        { name: '布艺沙发', material: 'upholstered', area: 3.2 },
        { name: '单层窗帘', material: 'curtain_thin', area: 5.4 },
      ],
      panel: { area: 0, material: 'panel_50', surface: 'wallN' },   // 吸声板
      listener: { fromWallL: null, fromWallW: null },               // null = 取房间中心
      speakerDistance: 1.6,
      targetRT60: 0.35,
    };
  }

  /* 一组内置场景：全部是虚构示例，改条件用；不代表任何真实房间或产品 */
  function scenarios() {
    return [
      { key: 'default', label: '默认：4.2×3.6×2.6 硬装房（几乎无吸声）', over: {} },
      { key: 'no_furniture', label: '把家具也算掉（无任何软装）', over: { furniture: [] } },
      { key: 'carpet', label: '地面换中厚地毯', over: { materials: Object.assign({}, defaults().materials, { floor: 'carpet_mid' }) } },
      { key: 'panels10', label: '贴 10 m² 吸声板（50 mm 贴墙）', over: { panel: { area: 10, material: 'panel_50', surface: 'wallN' } } },
      { key: 'studio', label: '小录音间：3.0×2.4×2.4 + 吸声处理', over: { L: 3.0, W: 2.4, H: 2.4, furniture: [], panel: { area: 8, material: 'panel_50_gap', surface: 'wallN' } } },
      { key: 'livingroom', label: '客厅：5.4×4.2×2.8 + 地毯窗帘', over: { L: 5.4, W: 4.2, H: 2.8, materials: Object.assign({}, defaults().materials, { floor: 'carpet_mid', wallN: 'curtain_heavy' }) } },
      { key: 'big_hall', label: '大面积硬装：8×6×3.2', over: { L: 8, W: 6, H: 3.2, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } } },
      { key: 'cube', label: '正方体房间 3×3×3（简并最严重）', over: { L: 3, W: 3, H: 3, furniture: [], panel: { area: 0, material: 'panel_50', surface: 'wallN' } } },
    ];
  }

  /* ─────────────── 校验（一次把所有错都报出来） ─────────────── */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function matById(id) { for (let i = 0; i < MATERIALS.length; i++) if (MATERIALS[i].id === id) return MATERIALS[i]; return null; }

  function checkNum(errors, key, label, value, lo, hi, unit) {
    if (!isNum(value)) { errors.push({ field: key, code: 'not_number', msg: label + '必须是数字' }); return false; }
    if (value < lo || value > hi) {
      errors.push({ field: key, code: 'out_of_range', msg: label + '要在 ' + lo + ' – ' + hi + (unit || '') + ' 之间（当前 ' + value + '）' });
      return false;
    }
    return true;
  }

  /* 材料在某频段的吸声系数（自定义材料读 customA；所有值都夹在 0–1，超出即报错）。
     类型先严格判：字符串 / null / undefined / NaN 一律返回 NaN，交给校验层报错，
     绝不让 Number(null)=0 这种隐式转换把非法输入变成「合法 0」。 */
  function coeffOf(matId, band, customA) {
    if (matId === 'custom') {
      const arr = Array.isArray(customA) ? customA : defaults().customA;
      const v = arr[band];
      if (typeof v !== 'number' || !isFinite(v)) return NaN;
      return v;
    }
    const m = matById(matId);
    if (!m) return NaN;
    const v = m.a[band];
    return (typeof v === 'number' && isFinite(v)) ? v : NaN;
  }

  function validate(raw) {
    const inp = Object.assign({}, defaults(), raw || {});
    // 嵌套对象分别合并，避免整体替换把缺的键丢掉
    inp.materials = Object.assign({}, defaults().materials, raw && raw.materials ? raw.materials : {});
    inp.panel = Object.assign({}, defaults().panel, raw && raw.panel ? raw.panel : {});
    inp.listener = Object.assign({}, defaults().listener, raw && raw.listener ? raw.listener : {});
    inp.furniture = Array.isArray(raw && raw.furniture) ? raw.furniture.slice(0, 20) : defaults().furniture;
    inp.customA = Array.isArray(raw && raw.customA) ? raw.customA : defaults().customA;

    const errors = [];

    checkNum(errors, 'L', '房间长度', inp.L, LIMITS.L[0], LIMITS.L[1], ' m');
    checkNum(errors, 'W', '房间宽度', inp.W, LIMITS.W[0], LIMITS.W[1], ' m');
    checkNum(errors, 'H', '房间高度', inp.H, LIMITS.H[0], LIMITS.H[1], ' m');
    checkNum(errors, 'targetRT60', '目标混响时间', inp.targetRT60, LIMITS.targetRT60[0], LIMITS.targetRT60[1], ' s');
    checkNum(errors, 'speakerDistance', '音箱到听音位距离', inp.speakerDistance, LIMITS.speakerDistance[0], LIMITS.speakerDistance[1], ' m');
    checkNum(errors, 'panel.area', '吸声板面积', inp.panel.area, LIMITS.panelArea[0], LIMITS.panelArea[1], ' m²');

    /* 六个面的材料必须在库里 */
    SURFACES.forEach(function (s) {
      const id = inp.materials[s.key];
      if (!matById(id)) {
        errors.push({ field: 'materials.' + s.key, code: 'bad_enum', msg: s.name + '的材料选了库里没有的项（' + id + '）' });
      }
    });
    if (!matById(inp.panel.material)) errors.push({ field: 'panel.material', code: 'bad_enum', msg: '吸声板的材料选了库里没有的项' });
    if (!SURFACES.some(function (s) { return s.key === inp.panel.surface; })) {
      errors.push({ field: 'panel.surface', code: 'bad_enum', msg: '吸声板安装面不在六个面里' });
    }

    /* 自定义系数 */
    if (!Array.isArray(inp.customA) || inp.customA.length < REF_FREQS.length) {
      errors.push({ field: 'customA', code: 'bad_shape', msg: '自定义吸声系数要 6 个数（125 / 250 / 500 / 1k / 2k / 4k Hz）' });
    } else {
      for (let b = 0; b < REF_FREQS.length; b++) {
        const v = inp.customA[b];
        // 严格判类型：Number(null)=0、Number('')=0 会把空值静默变成「合法 0」，这里不允许
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) {
          errors.push({ field: 'customA.' + b, code: 'out_of_range', msg: (REF_FREQS[b] + ' Hz 的自定义吸声系数要在 0 – 1 之间（当前 ' + inp.customA[b] + '）') });
        }
      }
    }

    /* 家具 */
    if (inp.furniture.length > LIMITS.furnitureCount[1]) {
      errors.push({ field: 'furniture', code: 'too_many', msg: '家具最多 ' + LIMITS.furnitureCount[1] + ' 件（当前 ' + inp.furniture.length + '）' });
    }
    inp.furniture.forEach(function (f, i) {
      if (!f || typeof f !== 'object') { errors.push({ field: 'furniture.' + i, code: 'bad_item', msg: '第 ' + (i + 1) + ' 件家具不是一条记录' }); return; }
      if (!matById(f.material)) errors.push({ field: 'furniture.' + i + '.material', code: 'bad_enum', msg: '第 ' + (i + 1) + ' 件家具（' + (f.name || '未命名') + '）的材料不在库里' });
      if (typeof f.area !== 'number' || !isFinite(f.area)) {
        errors.push({ field: 'furniture.' + i + '.area', code: 'not_number', msg: '第 ' + (i + 1) + ' 件家具的等效面积必须是数字（当前 ' + JSON.stringify(f.area) + '）' });
      } else {
        checkNum(errors, 'furniture.' + i + '.area', '第 ' + (i + 1) + ' 件家具的等效面积', f.area, 0, 200, ' m²');
      }
      if (typeof f.name !== 'string' || !f.name.trim()) errors.push({ field: 'furniture.' + i + '.name', code: 'empty', msg: '第 ' + (i + 1) + ' 件家具要有名字' });
    });

    /* 听音位：给了就必须落在房间里（含边界内 0.05 m 的余量） */
    [['fromWallL', inp.L, '长边方向（到起算墙的距离）'], ['fromWallW', inp.W, '短边方向（到起算墙的距离）']].forEach(function (t) {
      const v = inp.listener[t[0]];
      if (v === null || v === undefined || v === '') return;
      if (!isNum(v)) { errors.push({ field: 'listener.' + t[0], code: 'not_number', msg: '听音位' + t[2] + '必须是数字' }); return; }
      if (v < 0 || v > t[1]) {
        errors.push({ field: 'listener.' + t[0], code: 'out_of_range', msg: '听音位' + t[2] + '要在 0 – ' + t[1] + ' m 之间（当前 ' + v + '）' });
      }
    });

    /* 尺寸互相约束：统计声学在极端比例下更不可靠，这里只做最小限度的合理性提示（不报错） */
    return { ok: errors.length === 0, errors: errors, input: inp };
  }

  /* ─────────────── 几何 ─────────────── */

  function geometry(L, W, H) {
    const floor = L * W;
    const wallsLong = 2 * L * H;    // 两条长边墙
    const wallsShort = 2 * W * H;   // 两条短边墙
    return {
      V: L * W * H,
      floorArea: floor,
      ceilingArea: floor,
      wallLongEach: L * H,
      wallShortEach: W * H,
      totalSurface: 2 * floor + wallsLong + wallsShort,
      // 以「长边方向」为 x、短边方向为 y、高度为 z
      dims: { x: L, y: W, z: H },
    };
  }

  /* 六个面各自的面积 */
  function surfaceAreas(g) {
    return {
      floor: g.floorArea,
      ceiling: g.ceilingArea,
      wallN: g.wallLongEach,
      wallS: g.wallLongEach,
      wallE: g.wallShortEach,
      wallW: g.wallShortEach,
    };
  }

  /* ─────────────── 吸声量 ─────────────── */

  /* 逐面 × 逐频段的吸声量分解。返回 { total[band], bySurface[surfaceKey][band], byFurniture[band], panel[band] } */
  function absorption(inp, g) {
    const areas = surfaceAreas(g);
    const bySurface = {};
    const total = REF_FREQS.map(function () { return 0; });

    SURFACES.forEach(function (s) {
      const a = areas[s.key];
      const c = REF_FREQS.map(function (_, b) { return coeffOf(inp.materials[s.key], b, inp.customA); });
      bySurface[s.key] = { area: a, coeff: c, absorb: c.map(function (v) { return a * v; }) };
      c.forEach(function (v, b) { total[b] += a * v; });
    });

    /* 家具：等效吸声 = 等效面积 × 该材料系数（这是本页的口径，写在页面上） */
    const furniture = [];
    const byFurniture = REF_FREQS.map(function () { return 0; });
    inp.furniture.forEach(function (f) {
      const c = REF_FREQS.map(function (_, b) { return coeffOf(f.material, b, inp.customA); });
      const ab = c.map(function (v) { return f.area * v; });
      furniture.push({ name: f.name, material: f.material, materialName: (matById(f.material) || {}).name || f.material, area: f.area, coeff: c, absorb: ab });
      ab.forEach(function (v, b) { byFurniture[b] += v; });
    });

    /* 吸声板：只按面积计，不替换安装面原本的材料（如实写在页面：这是保守口径 —— 实际会遮住那部分墙面） */
    const pc = REF_FREQS.map(function (_, b) { return coeffOf(inp.panel.material, b, inp.customA); });
    const panel = pc.map(function (v) { return inp.panel.area * v; });

    panel.forEach(function (v, b) { total[b] += v; });
    byFurniture.forEach(function (v, b) { total[b] += v; });

    return { total: total, bySurface: bySurface, byFurniture: byFurniture, furniture: furniture, panel: panel, panelCoeff: pc, areas: areas };
  }

  /* RT60（Sabine + 可选空气吸收） */
  function rt60(V, A, m) {
    const denom = A + 4 * (m || 0) * V;
    if (!(denom > 0)) return Infinity;
    return SABINE_K * V / denom;
  }

  /* ─────────────── 驻波（房间模式） ─────────────── */

  /* 轴向模式：f = (c/2)·√((nx/L)²+(ny/W)²+(nz/H)²)，nx,ny,nz 非负整数且不全为 0。
   *
   * **枚举口径**（第一版在这里连错两次，记在质检报告里）：
   *   ① 每个**互不相同的下标三元组**就是一条模式，各算各的频率 —— (1,0,0)、(0,1,0)、(0,0,1)
   *      是三条模式，只有当 L=W=H 时它们的频率才恰好相等；
   *   ② 「简并度」= 频率落在同一个值上的模式条数，也就是**排列轨道的大小**：
   *      三个下标互不相同 → 1，两个相同 → 3，三个全同 → 1。
   *      （一条模式同时非零的方向数另算，叫 axisCount，1/2/3。）
   *   第一版只枚举 nx≥ny≥nz，把每个轨道只留一个代表 —— 简并度的分布看着没错，
   *   但「下标↔轴」的对应关系被打破，非最长那两个方向的一阶模式整条消失（自检当场报红）。
   *   第二版按「三个数排序后的字符串」分组，又把 (1,0,0)/(0,1,0)/(0,0,1) 当成一组，
   *   三条不同频率被压成一条。定稿版：按三元组本身存，另给「按频率归并」的视图。 */
  function roomModes(L, W, H, maxHz) {
    const list = [];
    for (let nx = 0; nx <= MODE_ORDER; nx++) {
      for (let ny = 0; ny <= MODE_ORDER; ny++) {
        for (let nz = 0; nz <= MODE_ORDER; nz++) {
          if (nx === 0 && ny === 0 && nz === 0) continue;
          const f = (C_SOUND / 2) * Math.sqrt(Math.pow(nx / L, 2) + Math.pow(ny / W, 2) + Math.pow(nz / H, 2));
          if (!(f > 0) || f > maxHz) continue;
          const axisCount = (nx ? 1 : 0) + (ny ? 1 : 0) + (nz ? 1 : 0);
          const orbitSize = permuteCount([nx, ny, nz]);       // 排列轨道大小（同一轨道内的成员才同频）
          list.push({ nx: nx, ny: ny, nz: nz, f: f, deg: orbitSize, axisCount: axisCount, key: [nx, ny, nz].join(',') });
        }
      }
    }
    list.sort(function (a, b) { return a.f - b.f || a.axisCount - b.axisCount || a.deg - b.deg; });

    /* 穷举口径：把 5×5×5 全部三元组数一遍（不做任何去重），用来给自检当独立对拍 */
    let bruteCount = 0;
    for (let ax = 0; ax <= MODE_ORDER; ax++) for (let ay = 0; ay <= MODE_ORDER; ay++) for (let az = 0; az <= MODE_ORDER; az++) {
      if (ax === 0 && ay === 0 && az === 0) continue;
      const ff = (C_SOUND / 2) * Math.sqrt(Math.pow(ax / L, 2) + Math.pow(ay / W, 2) + Math.pow(az / H, 2));
      if (ff > 0 && ff <= maxHz) bruteCount++;
    }

    /* 按频率归并的视图：同一频率只出现一次，频率数 = 互不相同的频率个数 */
    const byFreq = [];
    list.forEach(function (m) {
      const lastOne = byFreq[byFreq.length - 1];
      if (lastOne && Math.abs(lastOne.f - m.f) <= 1e-9) {
        lastOne.members.push(m.key);
        lastOne.axisCount = Math.max(lastOne.axisCount, m.axisCount);
        lastOne.deg = lastOne.members.length;
      } else {
        byFreq.push({ f: m.f, axisCount: m.axisCount, deg: 1, members: [m.key] });
      }
    });
    return { list: list, byFreq: byFreq, bruteCount: bruteCount };
  }

  /* 排列轨道大小：把 (nx,ny,nz) 分给 x,y,z 三个轴，能得到几个**互不相同**的三元组：
     三个下标互不相同 → 6；两个相同 → 3；三个全同 → 1。
     例 (2,1,0)：6 个排列都不同 → 6；例 (2,2,0)：只有 3 个 → 3。
     这个数就是 cube 里「同一个频率上叠了几条模式」的下限（立方体下恰好相等）。
     注意与「参与方向数」区分：(1,1,1) 的轨道大小是 1（只有一个排列），但它同时用到三个方向；
     (0,1,1) 的轨道大小是 3（0 挪到三个轴各一次），参与方向数是 2。 */
  function permuteCount(t) {
    const uniq = {};
    t.forEach(function (v) { uniq[v] = (uniq[v] || 0) + 1; });
    const counts = Object.keys(uniq).map(function (k) { return uniq[k]; });
    let denom = 1;
    counts.forEach(function (c) { for (let i = 2; i <= c; i++) denom *= i; });
    return 6 / denom;
  }

  /* 每个轴向模式的纯音频率（用于「每个方向各自的本征频率」表） */
  function axialFrequencies(L, W, H) {
    function series(dim) {
      const r = [];
      for (let n = 1; n <= MODE_ORDER; n++) r.push({ n: n, f: C_SOUND / (2 * dim) * n });
      return r;
    }
    return { length: series(L), width: series(W), height: series(H) };
  }

  /* 相邻模式间距：把 ≤300 Hz 的模式排序后看每两步之间差多少 */
  function modeSpacing(modes) {
    const gaps = [];
    for (let i = 1; i < modes.length; i++) {
      gaps.push({ from: modes[i - 1].f, to: modes[i].f, gap: modes[i].f - modes[i - 1].f });
    }
    return gaps;
  }

  /* 空档：50–120 Hz 内相邻模式间距 ≥ GAP_MIN_HZ（阈值是设计选择，不是标准） */
  function gapsInBand(modes, lo, hi, minGap) {
    const inBand = modes.filter(function (m) { return m.f >= lo && m.f <= hi; });
    const out = [];
    for (let i = 1; i < inBand.length; i++) {
      const g = inBand[i].f - inBand[i - 1].f;
      if (g >= minGap) out.push({ from: inBand[i - 1].f, to: inBand[i].f, gap: g });
    }
    let maxGap = 0, maxPair = null;
    for (let i = 1; i < inBand.length; i++) {
      const g = inBand[i].f - inBand[i - 1].f;
      if (g > maxGap) { maxGap = g; maxPair = [inBand[i - 1].f, inBand[i].f]; }
    }
    return { list: out, count: inBand.length, maxGap: maxGap, maxPair: maxPair };
  }

  /* ─────────────── 单点声学指标 ─────────────── */

  /* Schroeder 频率：统计声学与模态声学的分界 */
  function schroederHz(rt60_500, V) {
    if (!(V > 0) || !(rt60_500 > 0)) return NaN;
    return 2000 * Math.sqrt(rt60_500 / V);
  }

  /* Weyl 公式：频率 f 以下的模态数（含轴向 / 切向 / 斜向）
     M = (4π/3)V(f/c)³ + (π/4)S(f/c)² + (L_edge/8)(f/c) */
  function modalCount(f, V, S, edgeLen) {
    const k = f / C_SOUND;
    return (4 * Math.PI / 3) * V * Math.pow(k, 3) + (Math.PI / 4) * S * Math.pow(k, 2) + (edgeLen / 8) * k;
  }

  /* 临界距离：直达声与混响声相等的位置（Q=1） */
  function criticalDistance(A, Q) {
    const q = (Q == null ? 1 : Q);
    if (!(A > 0)) return 0;
    return 0.141 * Math.sqrt(q * A);
  }

  /* 听音位在某方向上的第 1 阶模式是压力腹点还是节点 */
  function listenerModes(inp, g) {
    const lx = (inp.listener.fromWallL === null || inp.listener.fromWallL === undefined) ? g.dims.x / 2 : inp.listener.fromWallL;
    const ly = (inp.listener.fromWallW === null || inp.listener.fromWallW === undefined) ? g.dims.y / 2 : inp.listener.fromWallW;
    function judge(pos, dim, f1) {
      // 压力按 cos(nπx/L)：腹点（|cos|≈1）在 x=0 与 x=L，节点（cos=0）在 x=L/2，n=1
      const c = Math.cos(Math.PI * pos / dim);
      const isNode = Math.abs(c) < 0.15;
      return { f: f1, cos: c, at: isNode ? 'node' : 'antinode', label: isNode ? '压力节点（听不到这一阶）' : '压力腹点（这一阶偏响）' };
    }
    return {
      x: Object.assign(judge(lx, g.dims.x, C_SOUND / (2 * g.dims.x)), { pos: lx, dim: g.dims.x, name: '长边方向' }),
      y: Object.assign(judge(ly, g.dims.y, C_SOUND / (2 * g.dims.y)), { pos: ly, dim: g.dims.y, name: '短边方向' }),
      z: Object.assign(judge(g.dims.z / 2, g.dims.z, C_SOUND / (2 * g.dims.z)), { pos: g.dims.z / 2, dim: g.dims.z, name: '高度方向（听音高度按房间中点）' }),
    };
  }

  /* ─────────────── 反解：目标 RT60 需要多少吸声量 ─────────────── */

  /* 目标吸声量 A_target = k·V/RT60；还要补的 = A_target − A_current */
  function requiredAbsorption(V, targetRT60, currentA) {
    if (!(targetRT60 > 0)) return { A_target: Infinity, need: Infinity };
    const A_target = SABINE_K * V / targetRT60;
    return { A_target: A_target, need: Math.max(0, A_target - currentA) };
  }

  /* 每一种材料 / 动作：把需要补的吸声量换成「多少 m²」。
     installed=false：当成独立加进来的吸声体，面积 = need / 该材料系数（本页主口径，用在空间里加东西）；
     installed=true ：把材料装到某个面上、替换该面原有材料，面积 = need /（新材料系数 − 原面系数），
                      系数不升高的组合没有解 —— 如实返回 null，不硬凑。 */
  function prescriptions(inp, g, need, band, surfaceKey) {
    const rows = [];
    MATERIALS.forEach(function (m) {
      if (m.id === 'custom') return;
      const cNew = m.a[band];
      const row = { material: m.id, name: m.name, coeff: cNew, freeArea: null, installedArea: null, cap: null };
      if (cNew > 0) {
        row.freeArea = need / cNew;
        if (row.freeArea > 200) row.cap = '超过 200 m²，超出本页输入上限';
      }
      if (surfaceKey && g) {
        const cOld = coeffOf(inp.materials[surfaceKey], band, inp.customA);
        const delta = cNew - cOld;
        row.delta = delta;
        if (delta > 1e-9) {
          const a = g && surfaceAreas(g)[surfaceKey];
          const maxArea = a;
          const rawArea = need / delta;
          row.installedArea = rawArea;
          row.installedMax = maxArea;
          row.installedFeasible = rawArea <= maxArea + 1e-9;
        }
      }
      rows.push(row);
    });
    rows.sort(function (a, b) {
      const av = a.freeArea === null ? Infinity : a.freeArea;
      const bv = b.freeArea === null ? Infinity : b.freeArea;
      return av - bv;
    });
    return rows;
  }

  /* ─────────────── 自检（页面上显示，也用测试守） ─────────────── */

  function runChecks(r) {
    const checks = [];
    function add(ok, name, detail) { checks.push({ ok: !!ok, name: name, detail: detail || '' }); }

    add(r.geometry.V > 0, '体积为正', 'V = ' + fmt(r.geometry.V, 2) + ' m³');
    add(Math.abs(r.geometry.totalSurface - (2 * r.geometry.floorArea + 2 * r.dims.x * r.dims.z + 2 * r.dims.y * r.dims.z)) < 1e-9,
      '总表面积与六个面之和一致', fmt(r.geometry.totalSurface, 3) + ' m²');

    /* 每个频段的吸声量必须等于各分项之和 */
    let sumOk = true;
    for (let b = 0; b < REF_FREQS.length; b++) {
      let s = 0;
      SURFACES.forEach(function (sf) { s += r.absorption.bySurface[sf.key].absorb[b]; });
      s += r.absorption.byFurniture[b] + r.absorption.panel[b];
      if (Math.abs(s - r.absorption.total[b]) > 1e-9) sumOk = false;
    }
    add(sumOk, '逐段吸声量 = 各面 + 家具 + 吸声板', '六段逐段核对');

    add(r.rt60[2] > 0 && isFinite(r.rt60[2]), '500 Hz 混响时间是有限正数', fmt(r.rt60[2], 3) + ' s');

    /* 混响时间随吸声量单调下降：把总吸声量翻倍，RT60 必须变小 */
    const doubled = rt60(r.geometry.V, r.absorption.total[2] * 2, AIR_M[500]);
    add(doubled < r.rt60[2], '吸声量翻倍 → RT60 变短', fmt(r.rt60[2], 3) + ' s → ' + fmt(doubled, 3) + ' s');

    /* 反解回代：补够吸声量后重算，应当等于目标值 */
    const A2 = r.absorption.total[2] + r.required.need;
    const rt2 = rt60(r.geometry.V, A2, AIR_M[500]);
    add(Math.abs(rt2 - r.input.targetRT60) < 0.005 || r.required.need === 0,
      '反解回代：补够吸声量后 500 Hz 回到目标值',
      fmt(rt2, 3) + ' s vs 目标 ' + fmt(r.input.targetRT60, 2) + ' s');

    add(r.modes.length > 0, '驻波清单非空', r.modes.length + ' 条模式（≤ ' + MODE_MAX_HZ + ' Hz）');
    add(r.modes.every(function (m) { return m.f > 0 && isFinite(m.f); }), '驻波频率都是有限正数', '');
    /* 三条一阶轴向模式必须都在：c/(2L)、c/(2W)、c/(2H)（第一版漏掉过非最长那两个方向） */
    const f1L = C_SOUND / (2 * r.input.L), f1W = C_SOUND / (2 * r.input.W), f1H = C_SOUND / (2 * r.input.H);
    const hasF = function (f, arr) { return arr.some(function (m) { return Math.abs(m.f - f) < 1e-9; }); };
    add(hasF(f1L, r.modes) && hasF(f1W, r.modes) && hasF(f1H, r.modes),
      '三个方向的一阶模式都在清单里', fmt(f1L, 2) + ' / ' + fmt(f1W, 2) + ' / ' + fmt(f1H, 2) + ' Hz');
    /* 模式清单条数必须等于「穷举全部合法下标三元组」的条数（独立口径对拍，一个不漏不重） */
    add(r.modes.length === r.bruteModeCount, '模式条数 = 穷举的合法下标三元组条数',
      r.modes.length + ' vs ' + r.bruteModeCount);
    /* 每条模式的下标↔轴对应必须真实成立（第一版漏掉过短边一阶） */
    add(r.modes.every(function (m) {
      const f0 = (C_SOUND / 2) * Math.sqrt(Math.pow(m.nx / r.input.L, 2) + Math.pow(m.ny / r.input.W, 2) + Math.pow(m.nz / r.input.H, 2));
      return Math.abs(f0 - m.f) < 1e-9;
    }), '每条模式的下标与轴对应正确', '');
    /* 按频率归并后：频率个数 ≤ 模式条数，且再没有两条同频 */
    add(r.modesByFreq.length <= r.modes.length && r.modesByFreq.length > 0,
      '按频率归并后的频率个数不多于模式条数', r.modesByFreq.length + ' 个频率 / ' + r.modes.length + ' 条模式');
    let freqUniq = true;
    for (let i = 1; i < r.modesByFreq.length; i++) if (Math.abs(r.modesByFreq[i].f - r.modesByFreq[i - 1].f) < 1e-9) freqUniq = false;
    add(freqUniq, '归并后的频率两两不同', '');
    add(r.modesByFreq.reduce(function (s2, m) { return s2 + m.deg; }, 0) === r.modes.length,
      '归并视图里各频率的简并度之和 = 模式条数',
      r.modesByFreq.reduce(function (s2, m) { return s2 + m.deg; }, 0) + ' vs ' + r.modes.length);
    add(r.modesByFreq.every(function (m) { return m.deg === m.members.length && m.deg >= 1; }),
      '归并视图里每条频率的简并度 = 它的成员条数', '');

    add(r.schroeder > 0 && isFinite(r.schroeder), 'Schroeder 频率是有限正数', fmt(r.schroeder, 1) + ' Hz');
    add(r.criticalDistance > 0, '临界距离为正', fmt(r.criticalDistance, 3) + ' m');
    add(r.planAreaOk, '处方面积要么是正数要么显式无解（不出现 NaN）', '');
    add(r.rt60.every(function (v) { return v > 0 && isFinite(v); }), '六个频段 RT60 都是有限正数', '');
    add(r.rt60[2] >= r.rt60[5] || r.absorption.total[2] >= r.absorption.total[5],
      '高频不会比中频更拖（除非吸声量也更大）', fmt(r.rt60[2], 3) + ' s vs ' + fmt(r.rt60[5], 3) + ' s');
    return checks;
  }

  /* ─────────────── 主计算 ─────────────── */

  function compute(raw) {
    const v = validate(raw);
    if (!v.ok) return { ok: false, errors: v.errors };
    const inp = v.input;
    const g = geometry(inp.L, inp.W, inp.H);
    const ab = absorption(inp, g);

    const rt60Bands = REF_FREQS.map(function (f, b) { return rt60(g.V, ab.total[b], AIR_M[f]); });
    const mm = roomModes(inp.L, inp.W, inp.H, MODE_MAX_HZ);
    const modes = mm.list;             // 每一条模式各占一行（下标↔轴的对应关系完整保留）
    const modesByFreq = mm.byFreq;     // 按频率归并：同一个频率只出现一次
    const bruteModeCount = mm.bruteCount;
    const axial = axialFrequencies(inp.L, inp.W, inp.H);
    const spacing = modeSpacing(modesByFreq);
    const gapInfo = gapsInBand(modesByFreq, GAP_RANGE[0], GAP_RANGE[1], GAP_MIN_HZ);

    const sch = schroederHz(rt60Bands[2], g.V);
    const cd = criticalDistance(ab.total[2], 1);
    const edgeLen = 4 * (inp.L + inp.W + inp.H);
    const modesBelowSch = modalCount(sch, g.V, g.totalSurface, edgeLen);

    const req = requiredAbsorption(g.V, inp.targetRT60, ab.total[2]);
    const presc = prescriptions(inp, g, req.need, 2, 'wallN');
    const lm = listenerModes(inp, g);

    /* 显示分组（设计选择，不是标准） */
    const v500 = rt60Bands[2];
    const verdict = v500 > 0.6 ? 'draggy' : (v500 >= 0.4 ? 'near' : 'dry');

    /* 参考：把整间房按某一种吸声处理铺满会是多少（用于「对照」而不是推荐） */
    const uniformRef = MATERIALS.filter(function (m) { return m.group === '吸声处理'; }).map(function (m) {
      const A = g.totalSurface * m.a[2];
      return { material: m.id, name: m.name, coeff: m.a[2], A: A, rt60: rt60(g.V, A, AIR_M[500]) };
    });

    const r = {
      ok: true,
      input: inp,
      geometry: Object.assign({}, g, { edgeLen: edgeLen }),
      dims: g.dims,
      absorption: ab,
      rt60: rt60Bands,
      bands: REF_FREQS.slice(),
      airM: AIR_M,
      modes: modes,
      modesByFreq: modesByFreq,
      bruteModeCount: bruteModeCount,
      axial: axial,
      spacing: spacing,
      gaps: gapInfo,
      gapMinHz: GAP_MIN_HZ,
      gapRange: GAP_RANGE,
      schroeder: sch,
      criticalDistance: cd,
      modalCountAtSchroeder: modesBelowSch,
      required: req,
      prescriptions: presc,
      listener: lm,
      verdict: verdict,
      verdictLabel: LABEL.verdict[verdict],
      uniformRef: uniformRef,
      surfaceList: SURFACES.map(function (s) { return { key: s.key, name: s.name }; }),
    };
    /* 处方：把需要补的吸声量摊到几种常用做法上（都不代表产品推荐）。
       面积一律显式算：能算给正数，算不出（系数没提高 / 缺口为 0）给 null 并在 note 里说明 ——
       绝不用 NaN 当「不可行」的哨兵（那样既看不出原因，又会污染 JSON 与页面）。 */
    const gap = req.need;
    const areaOf = function (addedCoeff, limit) {
      if (!(gap > 0)) return null;
      if (!(addedCoeff > 1e-12)) return null;
      const a = gap / addedCoeff;
      return (isFinite(a) && a >= 0 && (limit == null || a <= limit + 1e-9)) ? a : null;
    };
    const deltaOn = function (surfaceKey, matId) {
      return coeffOf(matId, 2, inp.customA) - coeffOf(inp.materials[surfaceKey], 2, inp.customA);
    };
    r.plan = {
      need: gap,
      A_target: req.A_target,
      A_current: ab.total[2],
      options: [
        { key: 'panel_wall', label: '长边墙贴 50 mm 多孔吸声板（替换原面材料）',
          area: areaOf(deltaOn('wallN', 'panel_50'), surfaceAreas(g).wallN),
          max: surfaceAreas(g).wallN, basis: deltaOn('wallN', 'panel_50') },
        { key: 'panel_free', label: '直接加 50 mm 多孔吸声板（按等效面积）',
          area: areaOf(coeffOf('panel_50', 2, inp.customA), null), max: null, basis: coeffOf('panel_50', 2, inp.customA) },
        { key: 'carpet', label: '地面换中厚地毯（替换原地面材料）',
          area: areaOf(deltaOn('floor', 'carpet_mid'), surfaceAreas(g).floor),
          max: surfaceAreas(g).floor, basis: deltaOn('floor', 'carpet_mid') },
        { key: 'trap_free', label: '加角落低频陷阱（按等效面积）',
          area: areaOf(coeffOf('bass_trap', 2, inp.customA), null), max: null, basis: coeffOf('bass_trap', 2, inp.customA) },
      ],
    };
    r.plan.options.forEach(function (o) {
      if (!(gap > 0)) o.note = '已经达标，不需要再补';
      else if (!(o.basis > 1e-12)) o.note = '这个组合的吸声系数没有提高，加它不会让混响变短';
      else if (o.area === null && o.max != null) o.note = '需要的面积超过这个面的面积（' + fmt(o.max, 2) + ' m²），单靠它做不到';
      else if (o.area === null) o.note = '算不出可行面积';
      else o.note = '';
    });
    /* 面积必须要么是正数、要么是 null —— 留一条自检守住这个契约 */
    r.planAreaOk = r.plan.options.every(function (o) { return o.area === null || (isFinite(o.area) && o.area >= 0); });

    /* 自检放在最后：它要读 plan 与 planAreaOk（先前放在对象字面量后面，
       而 const 声明尚未求值 → plan 还是 undefined，check 直接红。这个顺序 bug 是测试抓出来的）。 */
    r.checks = runChecks(r);
    r.selfCheckFailures = r.checks.filter(function (c) { return !c.ok; }).length;

    return r;
  }

  /* ─────────────── 格式化（页面与导出共用同一套） ─────────────── */

  function fmt(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    const n = (d == null ? 2 : d);
    return Number(x).toFixed(n);
  }
  function fmtRT(x) { return fmt(x, x >= 1 ? 2 : 3); }
  function fmtHz(x) { return fmt(x, 1); }
  function fmtM2(x) { return fmt(x, 2) + ' m²'; }
  function fmtArea(x) {
    if (!isFinite(x)) return '—';
    return x >= 100 ? fmt(x, 0) : (x >= 10 ? fmt(x, 1) : fmt(x, 2));
  }
  function fmtPct(x, d) { return fmt(x, d == null ? 1 : d) + '%'; }

  /* 六段吸声系数表（页面上的材料表用） */
  function materialRows() {
    return MATERIALS.map(function (m) { return { id: m.id, name: m.name, group: m.group, a: m.a.slice(), note: m.note }; });
  }
  function materialGroups() {
    const gs = [];
    MATERIALS.forEach(function (m) { if (gs.indexOf(m.group) < 0) gs.push(m.group); });
    return gs;
  }
  function surfaceRows() { return SURFACES.map(function (s) { return { key: s.key, name: s.name }; }); }
  function freqLabels() { return REF_FREQS.slice(); }

  return {
    C_SOUND: C_SOUND, SABINE_K: SABINE_K, REF_FREQS: REF_FREQS, MODE_MAX_HZ: MODE_MAX_HZ,
    AIR_M: AIR_M, LIMITS: LIMITS, LABEL: LABEL, GAP_MIN_HZ: GAP_MIN_HZ, GAP_RANGE: GAP_RANGE,
    MATERIALS: MATERIALS, SURFACES: SURFACES,
    defaults: defaults, scenarios: scenarios, validate: validate, compute: compute,
    geometry: geometry, surfaceAreas: surfaceAreas, absorption: absorption, rt60: rt60,
    roomModes: roomModes, axialFrequencies: axialFrequencies, modeSpacing: modeSpacing, gapsInBand: gapsInBand,
    schroederHz: schroederHz, criticalDistance: criticalDistance, modalCount: modalCount,
    listenerModes: listenerModes, requiredAbsorption: requiredAbsorption, prescriptions: prescriptions,
    coeffOf: coeffOf, matById: matById, permuteCount: permuteCount, runChecks: runChecks,
    materialRows: materialRows, materialGroups: materialGroups, surfaceRows: surfaceRows, freqLabels: freqLabels,
    fmt: fmt, fmtRT: fmtRT, fmtHz: fmtHz, fmtM2: fmtM2, fmtArea: fmtArea, fmtPct: fmtPct,
  };
});
