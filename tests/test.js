/**
 * 自动化测试 —— 零框架、零依赖。
 *
 * 手写一个刚好够用的 DOM mock（元素树 / appendChild 移动语义 /
 * textContent 清空语义 / scrollTop 按 scrollHeight 自动 clamp），
 * 直接在 Node 里跑：  node tests/test.js
 *
 * 覆盖：
 *   1. 高度估算 -> 测量修正后，总高度精确收敛到真实值；滚到底无空白
 *   2. 二分查找 indexAt：前缀表 / 外推均值更新后与线性扫描一致
 *   3. 快速跳跃滚动（拖动滚动条）后可视区间正确、占位高度正确
 *   4. DOM 节点复用：创建数封顶，且复用时不残留旧条目内容
 *   5. 内容变化（rerender）触发重新测量与位置修正
 */
'use strict';

var assert = require('assert');
var VirtualList = require('../js/virtual-list.js');

// ---------------------------------------------------------------
// 极简 DOM mock
// ---------------------------------------------------------------
function MockElement(tag, doc) {
  this.tagName = (tag || 'div').toUpperCase();
  this.doc = doc;
  this.parentNode = null;
  this.childNodes = [];
  this.style = {};
  this._attrs = Object.create(null);
  this.dataset = {};
  this._text = '';
  this.clientHeight = 0;
  this.clientWidth = 0;
  this._offsetHeight = 0;
  this._listeners = Object.create(null);

  var classes = [];
  this.classList = {
    add: function (c) { if (classes.indexOf(c) < 0) classes.push(c); },
    remove: function (c) { var k = classes.indexOf(c); if (k >= 0) classes.splice(k, 1); },
    contains: function (c) { return classes.indexOf(c) >= 0; }
  };
}

Object.defineProperties(MockElement.prototype, {
  children: {
    get: function () { return this.childNodes.filter(function (n) { return n.nodeType === 1; }); }
  },
  nodeType: { value: 1, configurable: true },
  offsetHeight: {
    get: function () { return this._offsetHeight; },
    set: function (v) { this._offsetHeight = v; },
    configurable: true
  },
  textContent: {
    get: function () {
      return this._text +
        this.childNodes.map(function (n) { return n.textContent || ''; }).join('');
    },
    set: function (v) {
      // 与浏览器一致：赋值 textContent 会销毁全部子节点
      for (var i = 0; i < this.childNodes.length; i++) {
        this.childNodes[i].parentNode = null;
      }
      this.childNodes = [];
      this._text = String(v);
    },
    configurable: true
  },
  innerHTML: {
    get: function () { return this._innerHTML || ''; },
    set: function (v) {
      this.textContent = '';
      this._innerHTML = String(v);
    },
    configurable: true
  }
});

MockElement.prototype.appendChild = function (child) {
  if (child.nodeType === 1 && child.parentNode) {
    // 浏览器语义：已挂载节点再次 appendChild 是“移动”，不是复制
    var sibs = child.parentNode.childNodes;
    sibs.splice(sibs.indexOf(child), 1);
  }
  this.childNodes.push(child);
  child.parentNode = this;
  return child;
};
MockElement.prototype.remove = function () {
  if (this.parentNode) {
    var sibs = this.parentNode.childNodes;
    sibs.splice(sibs.indexOf(this), 1);
    this.parentNode = null;
  }
};
MockElement.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
MockElement.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
};
MockElement.prototype.removeAttribute = function (k) { delete this._attrs[k]; };
MockElement.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
MockElement.prototype.removeEventListener = function (type, fn) {
  var arr = this._listeners[type];
  if (arr) arr.splice(arr.indexOf(fn), 1);
};
MockElement.prototype.dispatchEvent = function (type) {
  var arr = this._listeners[type] || [];
  for (var i = 0; i < arr.length; i++) arr[i]({ type: type });
};

function MockText(text) {
  this.nodeType = 3;
  this.textContent = String(text);
  this.parentNode = null;
}

function createDocument() {
  return {
    createElement: function (tag) { return new MockElement(tag, this); },
    createTextNode: function (t) { return new MockText(t); }
  };
}

/** 创建一个视口元素：scrollTop 赋值时按 scrollHeight-clientHeight 自动 clamp */
function createScroller(doc, clientHeight) {
  var el = doc.createElement('div');
  el.clientHeight = clientHeight;
  el._scrollTop = 0;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: function () {
      var sizer = el.children[0];
      return sizer ? (parseFloat(sizer.style.height) || 0) : clientHeight;
    }
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: function () { return el._scrollTop; },
    set: function (v) {
      var max = Math.max(0, el.scrollHeight - el.clientHeight);
      el._scrollTop = Math.max(0, Math.min(max, v));
    }
  });
  return el;
}

// ---------------------------------------------------------------
// 测试数据：确定性的“真实”高度，范围 40~320，初始估算只有 90
// ---------------------------------------------------------------
var COUNT = 5000;
var ESTIMATE = 90;
var VIEWPORT = 600;
var OVERSCAN = 6;

function trueHeight(i) {
  var x = (Math.imul(i + 1, 1103515245) + 12345) >>> 0;
  return 40 + (x % 281); // 40..320
}
var TRUE_SUM = (function () {
  var s = 0;
  for (var i = 0; i < COUNT; i++) s += trueHeight(i);
  return s;
})();

var rafQueue = [];
function makeEnv(renderItem) {
  var doc = createDocument();
  var scroller = createScroller(doc, VIEWPORT);
  var list = new VirtualList(scroller, {
    document: doc,
    requestAnimationFrame: function (cb) { rafQueue.push(cb); },
    itemCount: COUNT,
    estimatedHeight: ESTIMATE,
    overscan: OVERSCAN,
    renderItem: renderItem
  });
  return { doc: doc, scroller: scroller, list: list };
}
function flushRaf() {
  var q = rafQueue;
  rafQueue = [];
  q.forEach(function (cb) { cb(Date.now()); });
}
function simpleRender(i, el) {
  el.textContent = 'ITEM ' + i + ' H=' + trueHeight(i);
  el.offsetHeight = trueHeight(i);
}
function windowEl(list) {
  // sizer -> [topPad, window, bottomPad]
  return list.sizer.childNodes[1];
}
function mountedIndices(list) {
  return windowEl(list).children.map(function (node) {
    return parseInt(node.getAttribute('data-index'), 10);
  });
}
/** 线性扫描参照实现：offsetAt 上找满足 offset(i) <= y 的最大 i */
function bruteForceIndexAt(list, y) {
  var n = list.itemCount;
  if (n === 0) return -1;
  if (y <= 0) return 0;
  if (y >= list.offsetAt(n)) return n - 1;
  for (var i = n - 1; i >= 0; i--) {
    if (list.offsetAt(i) <= y) return i;
  }
  return 0;
}
/** 小步走遍全表（模拟真人逐屏滚动），步长小于 overscan 最小覆盖量 */
function walkToBottom(list, scroller) {
  var y = 0, guard = 0;
  while (y < list.totalHeight && guard++ < 20000) {
    scroller.scrollTop = y;
    list.layout();
    y += 200;
  }
  scroller.scrollTop = list.totalHeight + 999999;
  list.layout();
}
/** 反复钉在“当前底边”：模拟拖滚动条猛拽到底、内容增长后继续拽 */
function drainToBottom(list, scroller) {
  var guard = 0, prev = -1;
  while (guard++ < 5000) {
    scroller.scrollTop = list.totalHeight + 999999;
    list.layout();
    if (Math.abs(scroller.scrollTop + VIEWPORT - list.totalHeight) < 0.5 &&
        list.totalHeight === prev) break;
    prev = list.totalHeight;
  }
  return guard;
}

// ---------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------
var passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + '\n      ' +
      (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
  }
}

// ---------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------
console.log('\n[1] 高度估算与测量修正：总高度收敛到真实值');

test('初始状态：总高度 = n * 初始估算，全部未测量，外推均值=初始估算', function () {
  var doc = createDocument();
  var scroller = createScroller(doc, VIEWPORT);
  scroller.clientHeight = 0; // 视口不可见 -> 不渲染任何条目
  var list = new VirtualList(scroller, {
    document: doc, requestAnimationFrame: function (cb) { rafQueue.push(cb); },
    itemCount: COUNT, estimatedHeight: ESTIMATE, renderItem: simpleRender
  });
  assert.strictEqual(list.measuredCount, 0);
  assert.strictEqual(list.estimate, ESTIMATE);
  assert.strictEqual(list.totalHeight, COUNT * ESTIMATE);
  assert.strictEqual(list.offsetAt(123), 123 * ESTIMATE);
});

test('逐屏滚动完整遍历后每条都被测量，总高度精确等于真实值', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  walkToBottom(list, scroller);

  assert.strictEqual(list.measuredCount, COUNT, '应全部测量完毕');
  assert.strictEqual(list.estimate, TRUE_SUM / COUNT);
  assert.strictEqual(list.totalHeight, TRUE_SUM,
    '总高度精确收敛到真实总高，无底部空白 / 截断');
  for (var i = 0; i < COUNT; i++) {
    assert.strictEqual(list.heightAt(i), trueHeight(i));
    assert.strictEqual(list.offsetAt(i + 1) - list.offsetAt(i), trueHeight(i));
  }
});

test('测量推进过程中，外推均值向真实均值收敛、总高误差收窄', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  var errors = [];
  var y = 0, step = 0;
  while (y < list.totalHeight) {
    scroller.scrollTop = y;
    list.layout();
    if (step % 400 === 0) errors.push(Math.abs(list.totalHeight - TRUE_SUM));
    y += 200;
    step++;
  }
  var third = Math.max(1, Math.floor(errors.length / 3));
  var early = Math.max.apply(null, errors.slice(0, third));
  var late = Math.max.apply(null, errors.slice(-third));
  assert.ok(late < early, '后期误差(' + late + ')应小于前期(' + early + ')');
  assert.strictEqual(list.totalHeight, TRUE_SUM);
});

test('猛拽滚动条直接到底：底边立刻对齐无空白（未测区域按实测均值外推）', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  var iters = drainToBottom(list, scroller);
  var bottomPad = list.sizer.childNodes[2];

  assert.strictEqual(parseFloat(bottomPad.style.height), 0, '下方占位为 0');
  var idx = mountedIndices(list);
  assert.strictEqual(idx[idx.length - 1], COUNT - 1, '最后一条已挂载');
  assert.ok(Math.abs(scroller.scrollTop + VIEWPORT - list.totalHeight) < 1,
    '视口底边与内容底边对齐');
  // 外推无偏：只测了尾部一小撮条目，总高误差也应远小于“固定估算”方案
  var relError = Math.abs(list.totalHeight - TRUE_SUM) / TRUE_SUM;
  assert.ok(relError < 0.05,
    '相对误差 ' + (relError * 100).toFixed(2) + '%（固定估算方案此时约 50%），收敛轮数 ' + iters);
});

console.log('\n[2] 二分查找 indexAt：累积表/均值更新后依旧正确');

test('边界：y=0 -> 0；负值 -> 0；y>=总高 -> n-1；空表 -> -1', function () {
  var env = makeEnv(simpleRender);
  var list = env.list;
  assert.strictEqual(list.indexAt(0), 0);
  assert.strictEqual(list.indexAt(-5), 0);
  assert.strictEqual(list.indexAt(list.totalHeight), COUNT - 1);
  assert.strictEqual(list.indexAt(list.totalHeight + 999), COUNT - 1);

  var doc = createDocument();
  var scroller = createScroller(doc, 100);
  scroller.clientHeight = 0;
  var empty = new VirtualList(scroller, {
    document: doc, itemCount: 0, renderItem: function () {}
  });
  assert.strictEqual(empty.indexAt(0), -1);
  assert.strictEqual(empty.totalHeight, 0);
});

test('随机 y：与线性扫描一致（首屏测量后的混合表：真值+外推）', function () {
  var env = makeEnv(simpleRender);
  var list = env.list;
  for (var t = 0; t < 3000; t++) {
    var y = Math.random() * list.totalHeight;
    assert.strictEqual(list.indexAt(y), bruteForceIndexAt(list, y), 'y=' + y);
  }
});

test('直接写入若干测量值后，二分查找基于更新后的前缀表给出正确结果', function () {
  var env = makeEnv(simpleRender);
  var list = env.list;

  // 模拟第 100、500、4999 条被测量
  [100, 500, 4999].forEach(function (i) {
    list.heights[i] = trueHeight(i);
    list.measured[i] = 1;
    list.measuredTotal += trueHeight(i);
  });
  list._dirtyFrom = 100;
  list._rebuildPrefixes();

  for (var t = 0; t < 3000; t++) {
    var y = Math.random() * list.totalHeight;
    assert.strictEqual(list.indexAt(y), bruteForceIndexAt(list, y), 'y=' + y);
  }
  assert.strictEqual(list.indexAt(list.offsetAt(500)), 500);
  assert.strictEqual(list.indexAt(list.offsetAt(500) + 0.5), 500);
  assert.strictEqual(list.indexAt(list.offsetAt(501) - 0.5), 500);
});

test('全部标记为测量值后，二分查找与线性扫描一致（严格单调）', function () {
  var env = makeEnv(simpleRender);
  var list = env.list;
  for (var i = 0; i < COUNT; i++) {
    list.heights[i] = 1 + ((i * 7 + 3) % 50); // 1..50
    list.measured[i] = 1;
    list.measuredTotal += list.heights[i];
  }
  list._dirtyFrom = 0;
  list._rebuildPrefixes();

  for (var t = 0; t < 3000; t++) {
    var y = Math.random() * list.totalHeight;
    assert.strictEqual(list.indexAt(y), bruteForceIndexAt(list, y));
  }
});

console.log('\n[3] 快速跳跃滚动：可视区间与占位高度');

test('从顶部直接跳到接近底部：区间连续，覆盖纯可视区，占位高度与累积表一致', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  scroller.scrollTop = list.totalHeight - VIEWPORT - 1; // 模拟拖滚动条
  scroller.dispatchEvent('scroll');
  flushRaf();
  list.layout(); // 测量修正后再补一轮

  var idx = mountedIndices(list);
  assert.ok(idx.length > 0);
  for (var k = 1; k < idx.length; k++) assert.strictEqual(idx[k], idx[k - 1] + 1);

  var start = idx[0], end = idx[idx.length - 1];
  var visStart = bruteForceIndexAt(list, scroller.scrollTop);
  var visEnd = bruteForceIndexAt(list, scroller.scrollTop + VIEWPORT);
  assert.ok(start <= visStart, '上缓冲覆盖可视起点: ' + start + ' <= ' + visStart);
  assert.ok(end >= visEnd, '下缓冲覆盖可视终点: ' + end + ' >= ' + visEnd);

  var topPad = list.sizer.childNodes[0];
  var bottomPad = list.sizer.childNodes[2];
  assert.ok(Math.abs(parseFloat(topPad.style.height) - list.offsetAt(start)) < 0.01);
  assert.ok(Math.abs(parseFloat(bottomPad.style.height) -
    (list.totalHeight - list.offsetAt(end + 1))) < 0.01);
});

test('多次大幅来回跳跃，每轮区间都覆盖可视区且 DOM 严格升序', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  var targets = [0.99, 0.01, 0.5, 0.77, 0.13, 0.88, 0.0, 1.0, 0.33];
  targets.forEach(function (frac, round) {
    scroller.scrollTop = frac * list.totalHeight;
    list.layout();
    list.layout(); // 第二遍：测量修正后再校验

    var idx = mountedIndices(list);
    for (var k = 1; k < idx.length; k++) assert.strictEqual(idx[k], idx[k - 1] + 1);

    var visStart = bruteForceIndexAt(list, scroller.scrollTop);
    var visEnd = bruteForceIndexAt(list, scroller.scrollTop + VIEWPORT);
    assert.ok(idx[0] <= visStart, 'round ' + round + ' start');
    assert.ok(idx[idx.length - 1] >= visEnd, 'round ' + round + ' end');

    var sorted = idx.slice().sort(function (a, b) { return a - b; });
    assert.deepStrictEqual(idx, sorted);
  });
});

test('跳跃到未测区域引发批量修正，锚点条目视觉位置漂移不超过 1px', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  scroller.scrollTop = 300000;
  var anchorIndex = list.indexAt(300000);
  var intraBefore = 300000 - list.offsetAt(anchorIndex);
  list.layout();
  var intraAfter = scroller.scrollTop - list.offsetAt(anchorIndex);
  assert.ok(Math.abs(intraAfter - intraBefore) <= 1,
    '条内偏移 ' + intraBefore + ' -> ' + intraAfter);
});

console.log('\n[4] 节点复用与回收：不销毁重建，不残留旧内容');

test('预热后任意滚动不再新建节点（创建数封顶，约为可视+缓冲量级）', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  for (var frac = 0.0; frac <= 1.0; frac += 0.02) {
    scroller.scrollTop = frac * TRUE_SUM;
    list.layout();
  }
  var cap = list.nodesCreated;
  assert.ok(cap > 0 && cap <= 40, '峰值节点数 ' + cap);

  for (var f2 = 1.0; f2 >= 0.0; f2 -= 0.013) {
    scroller.scrollTop = f2 * TRUE_SUM;
    list.layout();
  }
  assert.strictEqual(list.nodesCreated, cap, '第二遍滚动全部走回收池复用');
  assert.ok(list.active.size < 60, '实际 DOM 仅 ' + list.active.size + ' 个 / 5000 条');
});

test('复用节点显示的一定是当前条目内容，无旧条目 token 残留', function () {
  var env = makeEnv(function (i, el) {
    el.textContent = 'IDX:' + i + ' TOKEN_' + i + ' H:' + trueHeight(i);
    el.offsetHeight = trueHeight(i);
  });
  var list = env.list, scroller = env.scroller;

  [0.0, 0.99, 0.1, 0.55, 0.02, 0.8, 0.3].forEach(function (frac) {
    scroller.scrollTop = frac * TRUE_SUM;
    list.layout();

    windowEl(list).children.forEach(function (node) {
      var i = parseInt(node.getAttribute('data-index'), 10);
      assert.strictEqual(node.textContent,
        'IDX:' + i + ' TOKEN_' + i + ' H:' + trueHeight(i),
        '节点内容必须与 data-index 完全一致');
    });
  });
});

test('外部塞进节点的“脏”子节点，在该节点被池化复用时被清空', function () {
  // 等高数据：每屏需要的节点数恒定，不相交跳跃间回收池被完整排空，
  // 可确定性追踪同一个节点的“回收 -> 复用”全过程。
  var FIXED_H = 100;
  var env = makeEnv(function (i, el) {
    el.textContent = 'ITEM ' + i + ' H=' + FIXED_H;
    el.offsetHeight = FIXED_H;
  });
  var list = env.list, scroller = env.scroller;

  var node = list.active.get(0);
  var dirty = env.doc.createElement('span');
  dirty.textContent = 'STALE_RESIDUAL';
  node.appendChild(dirty);
  assert.ok(node.textContent.indexOf('STALE_RESIDUAL') >= 0);

  scroller.scrollTop = 4000;
  list.layout();
  scroller.scrollTop = 2000;
  list.layout();

  assert.ok(node.parentNode === windowEl(list), '节点被复用回窗口（而非重建）');
  var newIndex = parseInt(node.getAttribute('data-index'), 10);
  assert.notStrictEqual(newIndex, 0, '确实在为另一个条目服务');
  assert.strictEqual(node.textContent, 'ITEM ' + newIndex + ' H=' + FIXED_H);
  assert.ok(node.textContent.indexOf('STALE_RESIDUAL') < 0, '脏内容已清除');
});

console.log('\n[5] 内容变化触发重新测量（rerender）');

test('挂载条目变高后：高度表、总高、后续偏移同步修正（全已测场景增量精确）', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  walkToBottom(list, scroller);          // 先全部测量，消除均值外推的平移项
  assert.strictEqual(list.measuredCount, COUNT);

  scroller.scrollTop = 100000;
  list.layout();
  var idx = mountedIndices(list);
  var changed = idx[3];
  var oldH = list.heightAt(changed);
  var oldTotal = list.totalHeight;
  var oldNextOffset = list.offsetAt(changed + 1);
  var newH = oldH + 123;

  list.renderItem = function (i, el) {
    var h = i === changed ? newH : trueHeight(i);
    el.textContent = 'ITEM ' + i + ' H=' + h;
    el.offsetHeight = h;
  };
  list.rerender();

  assert.strictEqual(list.heightAt(changed), newH);
  assert.strictEqual(list.totalHeight - oldTotal, 123, '无未测条目，总高增量精确');
  assert.strictEqual(list.offsetAt(changed + 1) - oldNextOffset, 123);
  var remounted = windowEl(list).children.filter(function (n) {
    return parseInt(n.getAttribute('data-index'), 10) === changed;
  })[0];
  assert.ok(remounted);
  assert.ok(remounted.textContent.indexOf('H=' + newH) >= 0);
});

test('部分已测时单条变高：总高按新均值无偏外推，已测前缀偏移仍精确', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  // 只在中部测一屏
  scroller.scrollTop = 200000;
  list.layout();
  var cnt = list.measuredCount;
  var idx = mountedIndices(list);
  var changed = idx[2];

  var oldTotal = list.totalHeight;
  var oldMeasuredSumAfterChanged = list.prefSum[changed + 1];

  list.renderItem = function (i, el) {
    var h = i === changed ? trueHeight(i) + 50 : trueHeight(i);
    el.textContent = 'ITEM ' + i;
    el.offsetHeight = h;
  };
  list.rerender();

  // 总高 = 实测总和 + 未测条数 * 新均值（公式恒成立）
  var E = list.estimate;
  assert.ok(Math.abs(list.totalHeight -
    (list.measuredTotal + (COUNT - cnt) * E)) < 1e-6);
  assert.ok(list.totalHeight > oldTotal, '变高 50px 经外推体现到全局总高');
  // 已测前缀存的是真值：该条前缀和恰好 +50
  assert.strictEqual(list.prefSum[changed + 1] - oldMeasuredSumAfterChanged, 50);
});

test('setItemCount 扩容 / 缩容后总高度正确且可继续滚动', function () {
  var env = makeEnv(simpleRender);
  var list = env.list, scroller = env.scroller;

  var oldTailOffset = list.offsetAt(COUNT);
  list.setItemCount(COUNT + 1000);
  assert.strictEqual(list.itemCount, COUNT + 1000);
  assert.ok(Math.abs(list.totalHeight - (oldTailOffset + 1000 * list.estimate)) < 1e-6);
  assert.strictEqual(list.heightAt(COUNT + 999), list.estimate);
  list.layout();

  list.setItemCount(100);
  assert.strictEqual(list.itemCount, 100);
  var expected = 0;
  for (var i = 0; i < 100; i++) expected += list.heightAt(i);
  assert.ok(Math.abs(list.totalHeight - expected) < 1e-6);
  scroller.scrollTop = 1e9;
  list.layout();
  var idx = mountedIndices(list);
  assert.strictEqual(idx[idx.length - 1], 99);
});

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
console.log('\n==========================================');
console.log('通过 ' + passed + ' 个，失败 ' + failed + ' 个');
if (failed) {
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
