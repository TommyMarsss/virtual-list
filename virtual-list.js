/*
 * VirtualList —— 原生 JavaScript 实现的不等高条目虚拟滚动列表
 *
 * 特性:
 *  - 只渲染可视区域 + 缓冲区内的真实 DOM 节点,其余用占位总高度代替
 *  - 条目高度未知时先用估算高度占位,真实渲染后测量并修正累积偏移表
 *  - 二分查找定位滚动位置对应的起始条目(O(log n))
 *  - 滑出可视区域的 DOM 节点进入对象池复用,不销毁重建
 *
 * 不依赖任何框架与第三方库,可同时运行于浏览器与 Node(测试)环境。
 */
(function (global) {
  'use strict';

  var raf = typeof global.requestAnimationFrame === 'function'
    ? function (cb) { return global.requestAnimationFrame(cb); }
    : function (cb) { return setTimeout(cb, 16); };

  /**
   * 二分查找:在单调不减的 offsets 数组(长度 count + 1,offsets[i] 表示
   * 第 i 条条目的顶部偏移)中,找到满足 offsets[i] <= value 的最大 i,
   * 并夹取到 [0, count - 1],即 value 落在第几条条目上。
   */
  function binarySearchIndex(offsets, count, value) {
    var lo = 0;
    var hi = count; // 搜索区间 [lo, hi],hi 可取到 count(列表总高度处)
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= value) lo = mid;
      else hi = mid - 1;
    }
    if (lo > count - 1) lo = count - 1;
    return lo;
  }

  /**
   * @param {Object} options
   *   container       可滚动容器元素(需固定高度、overflow-y: auto)
   *   items           数据数组
   *   estimatedHeight 未测量条目的估算高度(默认 50)
   *   buffer          上下缓冲区的像素高度(默认 300)
   *   renderItem      function(node, item, index) 把数据填充进节点,
   *                   必须完整覆盖节点内容(组件据此保证复用无残留)
   *   onUpdate        可选,每次渲染/修正完成后的回调,参数为调试信息对象
   */
  function VirtualList(options) {
    if (!options || !options.container) {
      throw new Error('VirtualList: options.container is required');
    }
    this.container = options.container;
    this.items = options.items || [];
    this.count = this.items.length;
    this.estimatedHeight = options.estimatedHeight || 50;
    this.buffer = options.buffer == null ? 300 : options.buffer;
    this.renderItem = options.renderItem || function () {};
    this.onUpdate = options.onUpdate || null;

    // ---- 高度数据结构 ----
    // heights[i]  : 第 i 条的高度(已测量为真实值,未测量为估算值)
    // measured[i] : 第 i 条是否已测量过真实高度
    // offsets[i]  : 前缀和,第 i 条的顶部偏移;offsets[count] 为列表总高度
    this.heights = new Array(this.count);
    this.measured = new Array(this.count);
    for (var i = 0; i < this.count; i++) {
      this.heights[i] = this.estimatedHeight;
      this.measured[i] = false;
    }
    this.offsets = new Array(this.count + 1);
    this._recomputeOffsets(0);

    // 占位元素:撑起滚动条总高度,真实节点绝对定位在其中
    this.phantom = global.document.createElement('div');
    this.phantom.className = 'virtual-list-phantom';
    this.phantom.style.position = 'relative';
    this.phantom.style.width = '100%';
    this.phantom.style.height = this._totalHeight() + 'px';
    this.container.appendChild(this.phantom);

    this.nodes = new Map(); // index -> DOM node,当前真实渲染的节点
    this.pool = [];         // 回收待复用的节点对象池

    this._startIndex = 0;
    this._endIndex = -1;
    this._scheduled = false;

    var self = this;
    this._onScroll = function () { self._scheduleUpdate(); };
    if (this.container.addEventListener) {
      this.container.addEventListener('scroll', this._onScroll);
    }

    this.update();
  }

  VirtualList.prototype._totalHeight = function () {
    return this.offsets[this.count];
  };

  /**
   * 从第 from 条起重算累积偏移表后缀:offsets[i+1] = offsets[i] + heights[i]。
   * 只重算受影响的 suffix,而不是从头线性扫描全表。
   */
  VirtualList.prototype._recomputeOffsets = function (from) {
    if (from < 0) from = 0;
    var offsets = this.offsets;
    var heights = this.heights;
    if (from === 0) offsets[0] = 0;
    for (var i = from; i < this.count; i++) {
      offsets[i + 1] = offsets[i] + heights[i];
    }
  };

  VirtualList.prototype._scheduleUpdate = function () {
    if (this._scheduled) return;
    this._scheduled = true;
    var self = this;
    raf(function () {
      self._scheduled = false;
      self.update();
    });
  };

  VirtualList.prototype._createNode = function () {
    var node = global.document.createElement('div');
    node.className = 'virtual-list-item';
    node.style.position = 'absolute';
    node.style.top = '0';
    node.style.left = '0';
    node.style.width = '100%';
    node.style.boxSizing = 'border-box';
    return node;
  };

  /**
   * 根据当前滚动位置计算可视区间(+缓冲区),回收区间外节点、
   * 复用或新建区间内节点,并按最新 offsets 摆放所有节点。
   */
  VirtualList.prototype._renderRange = function () {
    var scrollTop = this.container.scrollTop;
    var viewportH = this.container.clientHeight;
    var total = this._totalHeight();

    // 二分查找定位区间端点,不做线性扫描
    var start = binarySearchIndex(this.offsets, this.count, Math.max(0, scrollTop - this.buffer));
    var end = binarySearchIndex(this.offsets, this.count, Math.min(total, scrollTop + viewportH + this.buffer));
    this._startIndex = start;
    this._endIndex = end;

    // 回收滑出区间的节点到对象池(Map.forEach 过程中删除是安全的)
    var self = this;
    this.nodes.forEach(function (node, index) {
      if (index < start || index > end) {
        self.phantom.removeChild(node);
        self.pool.push(node);
        self.nodes.delete(index);
      }
    });

    // 区间内:复用池化节点或新建节点,renderItem 完整覆盖内容
    for (var i = start; i <= end; i++) {
      var node = this.nodes.get(i);
      if (!node) {
        node = this.pool.pop() || this._createNode();
        node.__index = i;
        if (node.dataset) node.dataset.index = String(i);
        this.renderItem(node, this.items[i], i);
        this.nodes.set(i, node);
        this.phantom.appendChild(node);
      }
      // 无论新旧节点都按最新 offsets 摆放(高度修正后位置可能已变)
      node.style.transform = 'translateY(' + this.offsets[i] + 'px)';
    }
  };

  /**
   * 测量当前渲染节点的真实高度,与记录值不一致时更新高度表并重算
   * 累积偏移后缀;若修正发生在锚点条目之前,同步调整 scrollTop
   * 保持视口内容稳定不跳动。
   * @returns {boolean} 是否有高度被修正(调用方需据此再渲染一轮)
   */
  VirtualList.prototype._measureAndCorrect = function () {
    var dirtyFrom = Infinity;
    var self = this;
    this.nodes.forEach(function (node, index) {
      var h = node.offsetHeight;
      if (h > 0) {
        // 只要真实渲染过就标记为已测量,即使真实值恰好等于估算值
        self.measured[index] = true;
        if (h !== self.heights[index]) {
          self.heights[index] = h;
          if (index < dirtyFrom) dirtyFrom = index;
        }
      }
    });
    if (dirtyFrom === Infinity) return false;

    // 记录锚点:当前滚动位置落在哪一条条目、条内偏移多少
    var scrollTop = this.container.scrollTop;
    var anchorIndex = binarySearchIndex(this.offsets, this.count, scrollTop);
    var anchorOffset = scrollTop - this.offsets[anchorIndex];

    this._recomputeOffsets(dirtyFrom);
    this.phantom.style.height = this._totalHeight() + 'px';

    // 被修正的条目在锚点之前(或就是锚点)时,恢复锚点位置避免视口跳动
    if (dirtyFrom <= anchorIndex) {
      this.container.scrollTop = this.offsets[anchorIndex] + anchorOffset;
    }
    return true;
  };

  /**
   * 渲染 + 测量修正的主循环:高度修正会改变 offsets,进而可能改变
   * 可视区间,因此修正后需要再渲染一轮,直到高度表收敛(带循环上限保护)。
   */
  VirtualList.prototype.update = function () {
    var guard = 0;
    while (guard++ < 20) {
      this._renderRange();
      if (!this._measureAndCorrect()) break;
    }
    if (this.onUpdate) this.onUpdate(this.getDebugInfo());
  };

  /**
   * 数据内容变化后调用:重新填充当前可见节点内容并重新测量修正。
   */
  VirtualList.prototype.refresh = function () {
    var self = this;
    this.nodes.forEach(function (node, index) {
      self.renderItem(node, self.items[index], index);
    });
    this.update();
  };

  VirtualList.prototype.scrollToIndex = function (index) {
    if (index < 0) index = 0;
    if (index > this.count - 1) index = this.count - 1;
    this.container.scrollTop = this.offsets[index];
    this.update();
  };

  VirtualList.prototype.getDebugInfo = function () {
    var measuredCount = 0;
    var errorSum = 0;
    var maxError = 0;
    for (var i = 0; i < this.count; i++) {
      if (this.measured[i]) {
        measuredCount++;
        var e = Math.abs(this.heights[i] - this.estimatedHeight);
        errorSum += e;
        if (e > maxError) maxError = e;
      }
    }
    return {
      startIndex: this._startIndex,
      endIndex: this._endIndex,
      renderedNodes: this.nodes.size,
      pooledNodes: this.pool.length,
      totalHeight: this._totalHeight(),
      measuredCount: measuredCount,
      avgError: measuredCount ? errorSum / measuredCount : 0,
      maxError: maxError
    };
  };

  VirtualList.binarySearchIndex = binarySearchIndex;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VirtualList;
  }
  global.VirtualList = VirtualList;
})(typeof window !== 'undefined' ? window : globalThis);
