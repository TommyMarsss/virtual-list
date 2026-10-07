/**
 * VirtualList —— 原生 JavaScript 不等高虚拟滚动列表
 *
 * 零依赖、零框架。UMD 封装：浏览器下挂到 window.VirtualList，
 * Node（测试）下通过 module.exports 导出。
 *
 *  ── 数据结构 ──────────────────────────────────────────────
 *   heights[i]  : 第 i 条的真实高度（仅 measured[i]=1 时有效）
 *   measured[i] : 该条高度是否已经过真实 DOM 测量（Uint8Array）
 *   prefSum[i]  : 前缀和 M(i) —— 区间 [0, i) 内“已测量”条目的真实高度之和
 *   prefCnt[i]  : 前缀计数 C(i) —— 区间 [0, i) 内已测量条目数
 *   E           : 外推估算高度 = 已测总高 / 已测条数
 *                 （一条都没测时用配置的 estimatedHeight）
 *
 *   于是任意条目的累积偏移无需物化、查询时计算：
 *       offsetAt(i) = M(i) + (i - C(i)) * E
 *   - 已测条目贡献真实高度，未测条目按当前实测均值无偏外推；
 *   - 测量越多 E 越准，全部测量后 offsetAt(n) 精确等于真实总高，
 *     从根本上避免“估算高度拍脑袋 → 滚到底还有大片空白/内容截断”；
 *   - E 随测量变化时不需要重算任何表（两张前缀表只与真实值有关）。
 *
 *   dirtyFrom : 一批测量中最小的被修正索引；prefSum/prefCnt 只从
 *               该位置向后增量重算（修正一条 = 其后所有累积值更新）。
 *
 *   active Map: index -> 当前挂载的真实 DOM 节点（可视区 + 缓冲区）
 *   pool[]    : 滑出区间后回收的节点，再次挂载优先复用而非新建
 *
 *  ── 二分查找 ──────────────────────────────────────────────
 *   indexAt(y) 在“键函数” key(i) = offsetAt(i) 上做 upper_bound 二分。
 *   key(i) 严格单调递增（每条高度恒正），测量修正 / E 更新后 key 自动
 *   跟着最新数据走，无需任何额外通知。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.VirtualList = factory();
  }
})(typeof self !== 'undefined' ? self
  : typeof globalThis !== 'undefined' ? globalThis
  : this, function () {
  'use strict';

  var DEFAULT_ESTIMATE = 84;
  var DEFAULT_OVERSCAN = 6;
  var MAX_LAYOUT_ITERATIONS = 16; // 测量修正 -> 区间变化 -> 再测量 的收敛上限

  function VirtualList(container, options) {
    options = options || {};

    this.doc = options.document ||
      (typeof document !== 'undefined' ? document : null);
    this._global = options.global ||
      (typeof globalThis !== 'undefined' ? globalThis : {});
    var raf = options.requestAnimationFrame || this._global.requestAnimationFrame;
    if (raf) {
      // 原生 requestAnimationFrame 要求 this 是 window，必须 bind，
      // 否则以普通函数方式调用会抛 Illegal invocation
      this._raf = options.requestAnimationFrame
        ? raf
        : raf.bind(this._global);
    } else {
      this._raf = function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
    }

    if (!this.doc) throw new Error('VirtualList: 需要 document 环境（浏览器或注入 mock）');
    if (!container) throw new Error('VirtualList: container 不能为空');
    if (typeof options.renderItem !== 'function') {
      throw new Error('VirtualList: renderItem(index, el) 回调必填');
    }

    this.scroller = container;
    this.renderItem = options.renderItem;
    this.onLayout = options.onLayout || null;
    this.initialEstimate = options.estimatedHeight || DEFAULT_ESTIMATE;
    this.overscan = options.overscan != null ? options.overscan : DEFAULT_OVERSCAN;

    // ---- 高度 / 前缀表 ----
    var n = options.itemCount || 0;
    this._initArrays(n);
    this.measuredTotal = 0; // 已测条目真实高度之和（measuredTotal/Cnt 即外推均值）

    // ---- DOM 节点池 ----
    this.active = new Map(); // index -> 已挂载节点
    this.pool = [];          // 已回收、可复用节点
    this.nodesCreated = 0;

    this._scheduled = false;
    this._inLayout = false;
    this._lastRange = { start: -2, end: -2 };

    this._buildDom();
    this._bindEvents();

    // 首次同步布局：首屏条目立刻测量修正，不等到下一帧
    this.layout();
  }

  VirtualList.prototype = {
    constructor: VirtualList,

    // ================= 公共 API =================

    /** 当前条目总数 */
    get itemCount() { return this.heights.length; },

    /** 已测量条目数 */
    get measuredCount() { return this.prefCnt[this.itemCount]; },

    /** 当前外推估算高度：已测条目的平均高度（无测量时用初始估算） */
    get estimate() {
      var cnt = this.prefCnt[this.itemCount];
      return cnt ? this.measuredTotal / cnt : this.initialEstimate;
    },

    /** 内容总高度 = 实测总和 + 未测条数 * 实测均值（全测完即真实总高） */
    get totalHeight() {
      return this.offsetAt(this.itemCount);
    },

    /**
     * 第 i 条顶部的累积偏移。
     * offsetAt(i) = M(i) + (i - C(i)) * E
     */
    offsetAt: function (i) {
      return this.prefSum[i] + (i - this.prefCnt[i]) * this.estimate;
    },

    /** 第 i 条当前记录的高度（已测为真实值，未测为当前外推估算值） */
    heightAt: function (i) {
      return this.measured[i] ? this.heights[i] : this.estimate;
    },

    /**
     * 二分查找：返回顶部位置 y 所在的条目索引
     * （满足 offsetAt(i) <= y 的最大 i）。offsetAt 严格单调递增。
     * 无论前缀表还是外推均值 E 更新后，查找都自动基于最新数据。
     */
    indexAt: function (y) {
      var n = this.itemCount;
      if (n === 0) return -1;
      if (y <= 0) return 0;
      var total = this.offsetAt(n);
      if (y >= total) return n - 1;

      var E = this.estimate, prefSum = this.prefSum, prefCnt = this.prefCnt;
      // upper_bound：第一个 key(mid) > y 的位置，再 -1
      var lo = 0, hi = n;
      while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        var key = prefSum[mid] + (mid - prefCnt[mid]) * E;
        if (key <= y) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    },

    /** 滚动到第 i 条 */
    scrollToIndex: function (i, align) {
      var n = this.itemCount;
      if (n === 0) return;
      i = Math.max(0, Math.min(n - 1, i));
      var top = this.offsetAt(i);
      if (align === 'center') {
        top = top - this.scroller.clientHeight / 2 + this.heightAt(i) / 2;
      }
      this.scroller.scrollTop = Math.max(0, top);
      this._scheduleLayout();
    },

    /** 修改条目数量（已测量高度尽量保留） */
    setItemCount: function (n) {
      n = Math.max(0, n | 0);
      var oldN = this.itemCount;

      // 缩容：先统计被丢弃条目里的已测高度，再替换数组
      var removedMeasured = 0;
      for (var k = n; k < oldN; k++) {
        if (this.measured[k]) removedMeasured += this.heights[k];
      }

      var heights = new Array(n);
      var measured = new Uint8Array(n);
      for (var i = 0; i < n; i++) {
        if (i < oldN) {
          heights[i] = this.heights[i];
          measured[i] = this.measured[i];
        } else {
          heights[i] = 0;
        }
      }
      this.heights = heights;
      this.measured = measured;
      this.prefSum = new Float64Array(n + 1);
      this.prefCnt = new Uint32Array(n + 1);
      this.measuredTotal -= removedMeasured;

      this._dirtyFrom = 0;
      this._rebuildPrefixes();
      this._scheduleLayout();
    },

    /**
     * 数据内容发生变化后调用：用 renderItem 重新渲染当前挂载节点。
     * 布局时重新测量，高度变化自动进入修正流程（含均值 E 与后续偏移）。
     */
    rerender: function () {
      var self = this;
      this.active.forEach(function (node, i) { self._render(i, node); });
      this.layout();
    },

    /** 立即执行一次完整的 “区间计算 -> 挂载回收 -> 测量修正” 流程 */
    layout: function () {
      if (this._inLayout) return;
      this._inLayout = true;
      try {
        // 锁定锚点：本次布局开始时，视口顶部压在哪个条目、条内偏移多少。
        // 无论后面测量修正 / 外推均值变化多少轮，最终把该条目钉回原位。
        var anchorIndex = this.itemCount ? this.indexAt(this.scroller.scrollTop) : -1;
        var anchorIntra = anchorIndex >= 0
          ? this.scroller.scrollTop - this.offsetAt(anchorIndex)
          : 0;

        var iter = 0;
        var prevStart = this._lastRange.start;
        var prevEnd = this._lastRange.end;
        for (;;) {
          var range = this._calcRange();
          var rangeChanged = range.start !== prevStart || range.end !== prevEnd;

          this._reconcile(range.start, range.end);

          // 读取所有挂载节点的真实高度（同步布局信息，少量节点，代价可接受）
          var corrections = this._collectMeasurements();

          if (!corrections.length && !rangeChanged) break;
          prevStart = range.start;
          prevEnd = range.end;

          if (corrections.length) {
            this._applyCorrections(corrections);
            // 还原锚点视觉位置（浏览器会在内容超出时自动 clamp）
            if (anchorIndex >= 0 && anchorIndex < this.itemCount) {
              this.scroller.scrollTop =
                Math.max(0, this.offsetAt(anchorIndex) + anchorIntra);
            }
          }

          // 前缀表 / 均值变化后区间可能需要扩大（真实高度比估算大时一屏
          // 条目变少），重算一轮直到“无新修正且区间稳定”（通常 1~2 轮）。
          if (++iter >= MAX_LAYOUT_ITERATIONS) break;
        }

        // 几何同步必须使用“最后一轮实际 reconcile 的区间”
        this._lastRange = range;
        this._updateGeometry();
        this._syncDebugAttrs();
        this._emitLayout();
      } finally {
        this._inLayout = false;
      }
    },

    destroy: function () {
      this.scroller.removeEventListener('scroll', this._onScroll);
      if (this._global.removeEventListener) {
        this._global.removeEventListener('resize', this._onResize);
      }
      if (this._ro) this._ro.disconnect();
      if (this.sizer.parentNode === this.scroller) {
        this.scroller.removeChild(this.sizer);
      }
    },

    // ================= 初始化 =================

    _initArrays: function (n) {
      this.heights = new Array(n);   // 仅 measured[i]=1 时有意义
      this.measured = new Uint8Array(n);
      this.prefSum = new Float64Array(n + 1); // M(i)
      this.prefCnt = new Uint32Array(n + 1);  // C(i)
      this._dirtyFrom = Infinity;
    },

    _buildDom: function () {
      var doc = this.doc;
      this.scroller.classList.add('vl-scroller');

      this.sizer = doc.createElement('div');
      this.sizer.className = 'vl-sizer';

      this.topPad = doc.createElement('div');
      this.topPad.className = 'vl-pad vl-top-pad';

      this.window = doc.createElement('div');
      this.window.className = 'vl-window';

      this.bottomPad = doc.createElement('div');
      this.bottomPad.className = 'vl-pad vl-bottom-pad';

      this.sizer.appendChild(this.topPad);
      this.sizer.appendChild(this.window);
      this.sizer.appendChild(this.bottomPad);
      this.scroller.appendChild(this.sizer);
    },

    _bindEvents: function () {
      var self = this;
      this._onScroll = function () { self._scheduleLayout(); };
      this.scroller.addEventListener('scroll', this._onScroll, { passive: true });

      // 容器尺寸变化（窗口 resize / 布局变化）时可视区会变，重算一次
      this._onResize = function () { self._scheduleLayout(); };
      if (this._global.addEventListener) {
        this._global.addEventListener('resize', this._onResize);
      }

      // 图片异步加载 / 内容自身变化会改变已挂载节点的高度：
      // ResizeObserver 负责捕获，触发一次重新测量。
      var RO = this._global.ResizeObserver;
      if (RO) {
        this._ro = new RO(function () { self._scheduleLayout(); });
      }
    },

    // ================= 区间计算（二分查找） =================

    _calcRange: function () {
      var n = this.itemCount;
      if (n === 0 || this.scroller.clientHeight <= 0) {
        return { start: -1, end: -1 };
      }
      var top = this.scroller.scrollTop;
      var bottom = top + this.scroller.clientHeight;
      var pad = this.overscan;

      var start = Math.max(0, this.indexAt(top) - pad);
      var end = this.indexAt(bottom);
      end = end < 0 ? -1 : Math.min(n - 1, end + 1 + pad);
      return { start: start, end: end };
    },

    // ================= 挂载 / 回收 / 复用 =================

    _createNode: function () {
      var node = this.doc.createElement('div');
      node.className = 'vl-item';
      node.setAttribute('data-index', '-1');
      if (this._ro) this._ro.observe(node);
      this.nodesCreated++;
      return node;
    },

    /**
     * 用节点 node 渲染第 i 条。
     * 关键：复用时必须先清空旧内容再交给 renderItem，杜绝旧条目状态残留。
     */
    _render: function (i, node) {
      // 清除上一条目留下的全部内容与可能的残留状态
      node.textContent = '';
      // data-index 先更新，保证任何异步回调都能识别节点的新身份
      node.setAttribute('data-index', String(i));
      // 业务回调负责填充内容（约定：若需修改 className，应整体赋值而非只 add）
      this.renderItem(i, node);
    },

    _reconcile: function (start, end) {
      var self = this;

      if (start < 0) {
        this.active.forEach(function (node) {
          node.remove();
          self.pool.push(node);
        });
        this.active.clear();
        return;
      }

      // 1) 滑出新区间的节点 -> 摘下来放进回收池
      this.active.forEach(function (node, i) {
        if (i < start || i > end) {
          node.remove();
          self.pool.push(node);
          self.active.delete(i);
        }
      });

      // 2) 新区间中缺失的节点 -> 优先取回收池复用，否则新建
      for (var i = start; i <= end; i++) {
        if (!this.active.has(i)) {
          var node = this.pool.pop() || this._createNode();
          this._render(i, node);
          this.active.set(i, node);
        }
      }

      // 3) 按索引顺序重排。appendChild 对已在文档中的节点是“移动”而非重建，
      //    复用节点的内部状态已在 _render 中整体重置。
      for (var j = start; j <= end; j++) {
        this.window.appendChild(this.active.get(j));
      }
    },

    // ================= 测量与高度修正 =================

    _collectMeasurements: function () {
      var corrections = [];
      var self = this;
      this.active.forEach(function (node, i) {
        var h = node.offsetHeight;
        // 高度为 0 通常意味着节点未参与布局（display:none 等），忽略
        if (h <= 0) return;
        if (!self.measured[i]) {
          corrections.push([i, h, false]); // 首次测量
        } else if (h !== self.heights[i]) {
          corrections.push([i, h, true]);  // 已测条目高度变化（内容更新）
        }
      });
      return corrections;
    },

    /**
     * 批量应用高度修正：
     *   - 更新 heights[i] / measured[i] 与已测总和（维护外推均值 E）；
     *   - prefSum / prefCnt 从最小被修正索引起向后增量重算，
     *     该条及其后所有条目的累积偏移一次性全部修正。
     */
    _applyCorrections: function (corrections) {
      var minIndex = Infinity;
      for (var k = 0; k < corrections.length; k++) {
        var i = corrections[k][0], h = corrections[k][1], wasMeasured = corrections[k][2];
        if (wasMeasured) {
          if (h === this.heights[i]) continue;
          this.measuredTotal += h - this.heights[i];
        } else {
          this.measuredTotal += h;
          this.measured[i] = 1;
        }
        this.heights[i] = h;
        if (i < minIndex) minIndex = i;
      }
      if (minIndex !== Infinity) {
        this._dirtyFrom = minIndex;
        this._rebuildPrefixes();
      }
    },

    /**
     * 从前缀表的脏点起增量重算：
     *   M(i) = M(i-1) + (measured[i-1] ? heights[i-1] : 0)
     *   C(i) = C(i-1) + measured[i-1]
     * 脏点之前的前缀不受影响。
     */
    _rebuildPrefixes: function () {
      var from = this._dirtyFrom;
      if (from === Infinity) return;
      var n = this.itemCount;
      for (var i = Math.max(1, from); i <= n; i++) {
        var j = i - 1;
        this.prefSum[i] = this.prefSum[i - 1] + (this.measured[j] ? this.heights[j] : 0);
        this.prefCnt[i] = this.prefCnt[i - 1] + this.measured[j];
      }
      this._dirtyFrom = Infinity;
    },

    // ================= 几何同步 =================

    _updateGeometry: function () {
      var n = this.itemCount;
      var start = this._lastRange.start;
      var end = this._lastRange.end;

      var top = start >= 0 ? this.offsetAt(start) : 0;
      var bottom = end >= 0 ? this.offsetAt(n) - this.offsetAt(end + 1)
                            : this.offsetAt(n);

      // 占位：未渲染区域完全不产生真实节点，只用两个占位 div 的高度撑开
      this.topPad.style.height = top + 'px';
      this.bottomPad.style.height = bottom + 'px';
      this.sizer.style.height = Math.ceil(this.offsetAt(n)) + 'px';

      this.topPad.dataset.label = '上方占位 ' + Math.round(top) + 'px（条目 0 – ' + (start - 1) + '）';
      this.bottomPad.dataset.label =
        '下方占位 ' + Math.round(bottom) + 'px（条目 ' + (end + 1) + ' – ' + (n - 1) + '）';
    },

    _syncDebugAttrs: function () {
      var E = this.estimate;
      var self = this;
      this.active.forEach(function (node, i) {
        if (!self.measured[i]) {
          node.removeAttribute('data-h');
          node.setAttribute('data-diff', '?');
          return;
        }
        var h = self.heights[i];
        node.setAttribute('data-h', String(Math.round(h)));
        var d = Math.round(h - E);
        node.setAttribute('data-diff', (d >= 0 ? '+' : '') + d);
      });
    },

    // ================= 调度 / 事件 =================

    _scheduleLayout: function () {
      if (this._scheduled || this._inLayout) return;
      this._scheduled = true;
      var self = this;
      this._raf(function () {
        self._scheduled = false;
        self.layout();
      });
    },

    _emitLayout: function () {
      if (!this.onLayout) return;
      var range = this._lastRange;
      var top = this.scroller.scrollTop;
      this.onLayout({
        start: range.start,
        end: range.end,
        visibleStart: this.itemCount ? this.indexAt(top) : -1,
        visibleEnd: this.itemCount ? this.indexAt(top + this.scroller.clientHeight) : -1,
        nodeCount: this.active.size,
        nodesCreated: this.nodesCreated,
        totalHeight: this.totalHeight,
        estimate: this.estimate,
        measuredCount: this.measuredCount,
        itemCount: this.itemCount,
        scrollTop: top
      });
    }
  };

  return VirtualList;
});
