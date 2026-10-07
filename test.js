/*
 * VirtualList 自动化测试 —— 不引入测试框架
 * 手写最小 mock DOM + 自制 assert,运行: node test.js
 */
'use strict';

// ---------------- 手写 mock DOM ----------------
// 只实现组件用到的最小 API:createElement / appendChild / removeChild /
// style / dataset / addEventListener / offsetHeight / clientHeight / scrollTop
var createdElementCount = 0;

function createMockElement(tag) {
  var el = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    className: '',
    parent: null,
    __height: 0, // 测试用:renderItem 设置,模拟真实渲染后的高度
    __listeners: {},
    textContent: '',
    innerHTML: '',
    clientHeight: 0,
    scrollTop: 0,
    appendChild: function (child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    removeChild: function (child) {
      var i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parent = null;
      return child;
    },
    addEventListener: function (type, fn) {
      (el.__listeners[type] = el.__listeners[type] || []).push(fn);
    }
  };
  Object.defineProperty(el, 'offsetHeight', {
    get: function () { return el.__height; }
  });
  createdElementCount++;
  return el;
}

global.document = {
  createElement: function (tag) { return createMockElement(tag); }
};

var VirtualList = require('./virtual-list.js');

// ---------------- 自制 assert ----------------
var passed = 0;
var failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}
function assertEq(actual, expected, msg) {
  assert(actual === expected, msg + '(期望 ' + expected + ',实际 ' + actual + ')');
}

// 可复现伪随机
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sum(arr) {
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

// 构造一个列表实例:realHeights 为条目真实高度(mock 的 offsetHeight)
function makeList(realHeights, options) {
  options = options || {};
  var container = createMockElement('div');
  container.clientHeight = options.viewportHeight || 600;
  var items = realHeights.map(function (h, i) { return { id: i, height: h }; });
  var list = new VirtualList({
    container: container,
    items: items,
    estimatedHeight: options.estimatedHeight || 50,
    buffer: options.buffer == null ? 100 : options.buffer,
    renderItem: function (node, item, index) {
      node.__height = item.height;          // 模拟真实渲染后的高度
      node.__contentIndex = index;          // 记录节点内容属于哪条,用于残留检测
      node.textContent = 'item-' + index;
    }
  });
  return { list: list, container: container, items: items };
}

// 让所有条目都被真实渲染并测量:反复定位第一个未测量条目并跳转过去。
// (不能简单线性步进 scrollTop:高度修正时的锚点保持会调整 scrollTop,
//  线性步进可能跳过条目)
function scrollThrough(list) {
  var guard = 0;
  while (guard++ < 100000) {
    var firstUnmeasured = -1;
    for (var i = 0; i < list.count; i++) {
      if (!list.measured[i]) { firstUnmeasured = i; break; }
    }
    if (firstUnmeasured === -1) break;
    list.scrollToIndex(firstUnmeasured);
  }
}

// ================= 用例 1:高度估算与修正后,总高度收敛到真实值 =================
console.log('\n[用例 1] 高度估算与修正:总高度收敛到真实值');
(function () {
  var rand = mulberry32(7);
  var N = 500;
  var realHeights = [];
  for (var i = 0; i < N; i++) realHeights.push(20 + Math.floor(rand() * 180)); // 20~199
  var env = makeList(realHeights, { estimatedHeight: 50 });
  var list = env.list;

  // 初始:未测量的条目仍使用估算高度占位(构造时会立即测量首屏条目)
  var allEstimated = true;
  for (var i = 0; i < N; i++) {
    if (!list.measured[i] && list.heights[i] !== 50) { allEstimated = false; break; }
  }
  assert(allEstimated, '未测量条目使用估算高度占位');
  assertEq(list._totalHeight(), sum(list.heights), '初始总高度与高度表自洽');

  scrollThrough(list);

  assert(list.measured.every(Boolean), '滚动全程后所有条目均被真实测量');
  assertEq(list._totalHeight(), sum(realHeights), '修正后总高度收敛到真实高度之和(底部无空白/截断)');
  // 累积表与高度表自洽
  var ok = list.offsets[0] === 0;
  for (var i = 0; i < N; i++) {
    if (list.offsets[i + 1] !== list.offsets[i] + realHeights[i]) { ok = false; break; }
  }
  assert(ok, '累积偏移表与真实高度完全自洽');
})();

// ================= 用例 2:二分查找在高度表更新后定位正确 =================
console.log('\n[用例 2] 二分查找:高度表更新后定位仍然正确');
(function () {
  var rand = mulberry32(13);
  var N = 1000;
  var realHeights = [];
  for (var i = 0; i < N; i++) realHeights.push(10 + Math.floor(rand() * 290));
  var env = makeList(realHeights, { estimatedHeight: 50 });
  var list = env.list;
  scrollThrough(list); // 触发全部测量修正,offsets 已更新

  // 线性扫描作为基准
  function linearIndex(offsets, count, v) {
    var r = 0;
    for (var i = 0; i <= count; i++) if (offsets[i] <= v) r = i;
    return Math.min(r, count - 1);
  }

  var total = list._totalHeight();
  var allMatch = true;
  for (var t = 0; t < 2000; t++) {
    var v = Math.floor(rand() * (total + 200)); // 含超出总高度的边界值
    var bs = VirtualList.binarySearchIndex(list.offsets, N, v);
    var ln = linearIndex(list.offsets, N, v);
    if (bs !== ln) { allMatch = false; break; }
  }
  assert(allMatch, '2000 个随机滚动位置:二分查找结果与线性扫描一致');

  // 边界:0、恰好落在条目边界、超过总高度
  assertEq(VirtualList.binarySearchIndex(list.offsets, N, 0), 0, 'scrollTop=0 定位到第 0 条');
  var boundary = list.offsets[123];
  assertEq(VirtualList.binarySearchIndex(list.offsets, N, boundary), 123, '恰好落在条目边界时定位到该条目');
  assertEq(VirtualList.binarySearchIndex(list.offsets, N, total + 9999), N - 1, '超出总高度时夹取到最后一条');
})();

// ================= 用例 3:快速跳跃滚动后可视条目计算正确 =================
console.log('\n[用例 3] 快速跳跃滚动:可视区间计算正确');
(function () {
  var rand = mulberry32(29);
  var N = 5000;
  var realHeights = [];
  for (var i = 0; i < N; i++) realHeights.push(20 + Math.floor(rand() * 230));
  var env = makeList(realHeights, { estimatedHeight: 50, buffer: 100 });
  var list = env.list;
  var container = env.container;
  var VH = container.clientHeight;
  scrollThrough(list); // 先让高度全部收敛

  var total = list._totalHeight();
  var allVisible = true;
  var rangeOk = true;
  for (var t = 0; t < 50; t++) {
    // 模拟拖动滚动条大幅跳跃
    container.scrollTop = Math.floor(rand() * total);
    list.update();
    var st = container.scrollTop; // 修正可能微调了 scrollTop

    // 与视口相交的每一条都必须有真实 DOM 节点
    for (var i = 0; i < N; i++) {
      var top = list.offsets[i];
      var bottom = list.offsets[i + 1];
      if (bottom > st && top < st + VH) {
        if (!list.nodes.has(i)) { allVisible = false; break; }
      }
    }
    // 渲染区间端点必须等于基于更新后累积表的二分查找结果
    var expectStart = VirtualList.binarySearchIndex(list.offsets, N, Math.max(0, st - 100));
    var expectEnd = VirtualList.binarySearchIndex(list.offsets, N, Math.min(list._totalHeight(), st + VH + 100));
    if (list._startIndex !== expectStart || list._endIndex !== expectEnd) rangeOk = false;
  }
  assert(allVisible, '50 次随机大幅跳跃:视口内条目全部有真实 DOM 节点');
  assert(rangeOk, '渲染区间端点与二分查找(基于更新后累积表)结果一致');

  // 跳到底部:最后一条必须被渲染,且底部无空白
  container.scrollTop = total - VH;
  list.update();
  assert(list.nodes.has(N - 1), '跳到底部时最后一条被渲染');
})();

// ================= 用例 4:节点复用与回收,无旧内容残留 =================
console.log('\n[用例 4] 节点复用:滑出节点被回收复用,且无旧内容残留');
(function () {
  var rand = mulberry32(41);
  var N = 1000;
  var realHeights = [];
  for (var i = 0; i < N; i++) realHeights.push(30 + Math.floor(rand() * 120));
  var env = makeList(realHeights, { estimatedHeight: 50, buffer: 100 });
  var list = env.list;
  var container = env.container;

  container.scrollTop = 0;
  list.update();
  var before = new Map();
  list.nodes.forEach(function (node, index) { before.set(index, node); });
  var firstNodes = new Set(before.values());
  var createdBefore = createdElementCount;

  // 向下滚动约两屏,触发回收与复用
  container.scrollTop = 1500;
  list.update();

  var reused = 0;
  var residual = 0;
  list.nodes.forEach(function (node, index) {
    if (firstNodes.has(node)) {
      var oldIndex = -1;
      before.forEach(function (n, i) { if (n === node) oldIndex = i; });
      if (oldIndex !== index) {
        reused++;
        // 复用的节点内容必须已完整更新为新条目,不得残留旧条目内容
        // (全等比较,避免 'item-5' 是 'item-50' 子串的误判)
        if (node.__contentIndex !== index) residual++;
        if (node.textContent !== 'item-' + index) residual++;
      }
    }
  });
  assert(reused > 0, '滚动后滑出的节点被复用到新位置(复用数: ' + reused + ')');
  assertEq(residual, 0, '复用节点无旧内容残留');

  // 全程滚动后,创建的 DOM 节点总数应远小于条目数(复用生效)
  scrollThrough(list);
  var createdTotal = createdElementCount - createdBefore + firstNodes.size;
  assert(createdTotal < 100, '滚动全程创建的 DOM 节点数(' + createdTotal + ')远小于条目数(' + N + ')');

  // 每个在渲染区间内的节点,dataset.index 与其服务的条目一致
  var indexConsistent = true;
  list.nodes.forEach(function (node, index) {
    if (node.dataset.index !== String(index) || node.__contentIndex !== index) {
      indexConsistent = false;
    }
  });
  assert(indexConsistent, '所有在渲染节点的索引标记与其内容一致');
})();

// ================= 用例 5:内容动态变化后高度重新测量修正 =================
console.log('\n[用例 5] 条目内容变化导致高度改变:重新测量并修正');
(function () {
  var rand = mulberry32(53);
  var N = 300;
  var realHeights = [];
  for (var i = 0; i < N; i++) realHeights.push(40 + Math.floor(rand() * 100));
  var env = makeList(realHeights, { estimatedHeight: 50 });
  var list = env.list;
  var container = env.container;
  scrollThrough(list);
  var oldTotal = list._totalHeight();
  assertEq(oldTotal, sum(realHeights), '变化前总高度已收敛');

  // 组件只能重新测量"当前渲染中"的条目,因此修改可视区间内条目的高度,
  // 模拟内容变化(未渲染条目的新高度要等滚动到那里才能测得,符合预期)
  container.scrollTop = 0;
  list.update();
  var delta = 0;
  var changedCount = 0;
  list.nodes.forEach(function (node, k) {
    var nh = 100 + Math.floor(rand() * 200);
    delta += nh - env.items[k].height;
    env.items[k].height = nh;
    changedCount++;
  });
  assert(changedCount > 0, '可视区间内有条目被修改(' + changedCount + ' 条)');
  list.refresh(); // 重新渲染可见节点并测量修正

  assertEq(list._totalHeight(), oldTotal + delta, '内容变化后总高度按差值修正');
  var newReal = env.items.map(function (it) { return it.height; });
  assertEq(list._totalHeight(), sum(newReal), '修正后总高度等于新的真实高度之和');
})();

// ---------------- 汇总 ----------------
console.log('\n========================================');
console.log('通过 ' + passed + ' 项,失败 ' + failed + ' 项');
if (failed > 0) {
  process.exit(1);
} else {
  console.log('全部测试通过 ✓');
}
