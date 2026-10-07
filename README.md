# virtual-list — 原生 JS 不等高虚拟滚动列表

零框架、零第三方依赖的虚拟滚动组件，支持**条目高度未知 / 动态变化**，只渲染可视区
加缓冲区的真实 DOM，其余区域用两个占位 `div` 撑开高度。

- `js/virtual-list.js` — 组件本体（UMD，约 400 行，浏览器 / Node 均可加载）
- `index.html` — 演示页：6000 条随机高度数据（多行文本 + 随机尺寸图片占位 + 标签），
  含调试模式、跳转、触底、随机改内容
- `tests/test.js` — 零依赖自动化测试（手写 DOM mock + `assert`），`node tests/test.js`
- `server.go` — 可选的 Go 静态服务器

## 运行

```bash
# 方式一：直接用浏览器打开 index.html 即可（file:// 也能跑，无外部资源）

# 方式二：起本地服务
go run server.go            # http://localhost:8080/index.html

# 测试（需要 Node.js，无任何 npm 依赖）
node tests/test.js

# 真实浏览器冒烟（Chrome headless，真实 offsetHeight / scrollTop / ResizeObserver）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --dump-dom \
  "file://$PWD/tests/browser-smoke.html" | grep -oE 'SMOKE-(PASS|FAIL) [^<]*'
```

---

## 一、数据结构

| 字段 | 类型 | 含义 |
|---|---|---|
| `heights[i]` | `number[]` | 第 `i` 条的**真实**高度，仅 `measured[i]=1` 时有效 |
| `measured[i]` | `Uint8Array` | 第 `i` 条是否已经过真实 DOM 测量 |
| `prefSum[i]` | `Float64Array` | 前缀和 `M(i)`：区间 `[0, i)` 内**已测**条目真实高度之和 |
| `prefCnt[i]` | `Uint32Array` | 前缀计数 `C(i)`：区间 `[0, i)` 内已测条目数 |
| `measuredTotal` | `number` | 已测条目真实高度总和，`measuredTotal / measuredCount` 即外推均值 |
| `estimate (E)` | getter | 外推估算高度 = 已测条目平均高度；一条都没测时用配置的 `estimatedHeight` |
| `active` | `Map<index, node>` | 当前挂载的真实节点（可视区 + overscan 缓冲区） |
| `pool` | `node[]` | 回收池：滑出区间的节点摘下暂存，优先复用 |
| `_dirtyFrom` | number | 一批测量修正中最小的被修正索引，前缀表从此处增量重算 |

累积偏移表**不物化**，查询时即时计算：

```
offsetAt(i) = M(i) + (i − C(i)) · E
             └ 已测部分真值 ┘   └ 未测部分按实测均值外推 ┘
```

总高度 `totalHeight = offsetAt(n)`。

### 为什么不用“每条一个估算高度”的物化累积表？

若未测条目统一拍一个固定估算值（如 90px），而真实均值是 180px，那么：
总高度永远差一半；更关键的是**用户把滚动条一把拖到底时，浏览器按当前（错误的）
总高 clamp `scrollTop`，中间 4000 条从未进入过可视区，永远不会被渲染、测量、修正**
——信息论上组件不可能知道从没渲染过的内容有多高，表现就是“滚到底部还有大片空白”。

本方案用**已测条目的样本均值对未测区域做无偏外推**（react-window 同类思路）：

- 刚打开时只有首屏被测量，`E` 是一小撮条目的均值，总高已经是统计无偏估计；
- 随着测量样本增大，`E → 真实均值`，总高单调收敛，全部测量后**精确等于真实总高**；
- 已测条目的位置永远精确（前缀表存的是真值，不受均值变动影响）；
- `E` 变化时**不需要重算任何表**——两张前缀表只与真实测量值有关。

## 二、高度动态测量与位置修正

渲染管线（`layout()`）：

```
            ┌─────────────────────────────────────────────┐
            │ 1. 锁定锚点：视口顶部所在条目 + 条内偏移       │
            └─────────────────────────────────────────────┘
                                   │
   ┌───────────────────────────────▼───────────────────────────────┐
   │ 2. _calcRange  : 二分查找可视起点/终点，向两侧各扩 overscan 条  │
   │ 3. _reconcile  : 回收区间外节点入池；池中有节点则复用，否则新建  │
   │ 4. _collectMeasurements : 读取每个挂载节点的 offsetHeight       │
   │ 5. _applyCorrections : 写入真实高度，前缀表从 dirtyFrom 增量重算 │
   │ 6. 还原锚点：scrollTop = offsetAt(anchor) + 条内偏移            │
   └───────────────────────────────┬───────────────────────────────┘
                                   │ 区间是否变化 / 是否还有新高度？
                          是 ──────┘ （最多 16 轮兜底，实测 1~2 轮收敛）
                                   │ 否
            ┌───────────────────────▼────────────────────────┐
            │ 7. 更新上下占位高度 / sizer 总高 / 调试属性        │
            └─────────────────────────────────────────────────┘
```

要点：

1. **先估算占位，渲染后修正。** 条目首次进入区间时按当前 `E` 占位（撑在
   `sizer` 总高里），挂载后读 `offsetHeight` 得到真值，写入 `heights[i]`。
2. **修正一条 = 其后全部条目偏移更新。** 前缀表从最小脏索引 `dirtyFrom`
   起做一次 `O(未决后缀)` 的递推：`M(i)=M(i−1)+…`，`C(i)=C(i−1)+measured`。
   批量测量（快速跳跃落地时整屏都是新条目）只重算一次后缀。
3. **锚点防跳动。** 一次 `layout()` 开始时记录“视口顶部压在哪个条目、条内偏移
   多少像素”，无论修正多少轮，结束时把该条目钉回同一视觉位置
   （`scrollTop` 超界时浏览器自动 clamp）。因此视口上方条目变高/变矮不会把
   当前内容顶走，拖滚动条时也不会回弹。
4. **内容变化。** `rerender()` 用 `renderItem` 重绘当前挂载节点；已测条目高度
   变化时走 `[i, h, wasMeasured=true]` 分支，同步修正 `measuredTotal` 与后缀。
   `ResizeObserver` 兜底捕获图片异步加载等引起的高度变化（无 RO 的环境降级为
   只在滚动/resize 时重测）。

## 三、二分查找

`indexAt(y)` 在键函数 `key(i) = offsetAt(i)` 上做 `upper_bound` 二分：
找第一个 `key(mid) > y` 的位置再减 1。`key(i)` 严格单调递增（条目高度恒正），
所以即使条目等高、键值密集也正确。

高度表更新后无需任何“通知”：二分每次读的都是 `prefSum/prefCnt/estimate` 的
最新值，天然基于更新后的累积表。复杂度 `O(log n)`，5000 条约 13 次比较，
拖滚动条任意跳跃都不产生线性扫描。

## 四、节点复用 / 回收策略

```
新滚动区间 [start, end]
  ① active 中索引落在区间外的节点 → node.remove() + 压入 pool
  ② 区间内缺失的索引 → pool.pop() 复用（不足才 createElement）
 ③ 对区间内每个索引按序 window.appendChild(node)
     —— 对已在文档中的节点，appendChild 是“移动”而非重建
```

**防旧内容残留**是复用正确性的关键，复用分三步：

1. `_render(i, node)` 先执行 `node.textContent = ''` —— 浏览器语义是销毁全部
   子节点，上一条目遗留的 DOM、文本、第三方控件脏节点一并清除；
2. 先更新 `data-index` 再调用业务 `renderItem(i, el)`（ResizeObserver 等
   异步回调永远读到节点的新身份）；
3. 最后按索引统一 `appendChild` 重排，保证窗口内 DOM 顺序与数据顺序严格一致。

因此同一个 DOM 节点可能先后服务条目 #3 → #4201 → #815，但任何时刻
`data-index` 与其内容必然一致。测试里有专门用例：人为往节点里塞一个
`STALE_RESIDUAL` 脏子节点，追踪它回收再复用后脏内容被清空、身份与内容匹配。

## 五、调试模式

演示页点「🐞 调试模式」：

- 每个真实节点虚线描边，角标显示 `#index h=实测高度 Δ=与外推均值之差`（`?` 为未测量）；
- 上下两个斜纹区域即占位 `div`，中间标注占位像素与所覆盖的条目范围；
- 底部黑栏显示挂载区间（含 overscan）、纯可视区间、真实 DOM 数量、
  累计创建节点数、外推均值 E。

可配合「滚到底部」「跳转到 index」「随机改 20 条内容」验证触底无空白、
跳跃定位与动态重测。

## 六、测试

`node tests/test.js`，共 17 个用例，自带一个极简 DOM mock
（实现元素树、`appendChild` 的移动语义、`textContent` 清空语义、
`scrollTop` 按 `scrollHeight` 自动 clamp——这些正是组件依赖的浏览器契约）：

1. **高度收敛**：初始总高 = n×估算；小步走遍全表后每条已测、总高精确等于
   真实值；过程中误差单调收窄；一把拖到底时底边立即对齐、相对误差 < 5%
   （固定估算方案此时约 50%）。
2. **二分查找**：边界、随机 3000 点对拍线性扫描、前缀表局部更新后对拍、
   全表替换为随机高度后对拍。
3. **快速跳跃**：一次跳到接近底部，区间连续且覆盖纯可视区、占位高度等于
   累积表值；9 次大幅来回跳跃逐轮校验；锚点视觉漂移 ≤ 1px。
4. **节点复用**：预热后再整表来回滚，`nodesCreated` 不再增长；每个节点内容
   与 `data-index` 一致；外部注入的脏子节点在复用后被清空。
5. **动态更新**：已测条目变高后总高/后缀偏移精确 +123；部分已测时按新均值
   无偏外推；`setItemCount` 扩容/缩容后总高正确、可继续滚。

## API

```js
const list = new VirtualList(container, {
  itemCount: 6000,            // 条目数
  estimatedHeight: 90,        // 初始估算高度（首屏测量前使用）
  overscan: 6,                // 可视区上下各多渲染的条数
  renderItem(index, el) { … } // 必填：把第 index 条内容填入 el
});

list.onLayout = (info) => { … };   // 每次布局完成的统计信息
list.scrollToIndex(i);             // 或 list.scrollToIndex(i, 'center')
list.rerender();                   // 数据内容变化后重绘并重测
list.setItemCount(n);              // 条目数变化（已测高度尽量保留）
list.indexAt(y);                   // 暴露二分查找（测试/外部使用）
list.offsetAt(i);                  // 第 i 条当前累积偏移
list.totalHeight;                  // 当前内容总高（真值 + 外推）
list.destroy();
```

`renderItem` 约定：修改节点类名时整体赋值（`el.className = …`）而不是只 `add`，
填充用户文本优先用 `textContent`。
