import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLayerTree, CoDesignClient } from "../src/client.js";
import { buildSpec } from "../src/spec.js";
import type { Layer, ScreenDetail } from "../src/types.js";

// 本文件锁死一批「数据形态导致的功能错误」的修复：
// 样例数据都是构造出来的中性占位值，但字段形态与线上接口实测一致。

const screen: ScreenDetail = {
  id: 1,
  name: "示例画板",
  width: 750,
  height: 1612,
  designId: 2,
  source: "",
  slicesCount: 0,
};

/** 造一个原始 meta 节点 */
function node(over: Record<string, any> = {}) {
  return {
    object_id: "1",
    parent_id: "root",
    id: "1",
    type: "shape",
    name: "图层",
    index: 0,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 层叠顺序：index 是全局绘制顺序，layers 与 groups 是两个独立数组
// ---------------------------------------------------------------------------

test("buildLayerTree 按 index 排序，组不会被排到所有形状之后", () => {
  // 线上真实形态：layers 数组在前、groups 数组在后，索引却交错
  const layers = [
    node({ object_id: "1", index: 0 }),
    node({ object_id: "22", index: 1 }),
    node({ object_id: "12", index: 9 }),
    node({ object_id: "10", index: 15, type: "text" }),
  ];
  const groups = [
    node({ object_id: "49", index: 7, type: "group", parent_id: "root" }),
    node({ object_id: "73", index: 29, type: "group", parent_id: "root" }),
  ];

  const tree = buildLayerTree([...layers, ...groups], "root");
  assert.deepEqual(
    tree.map((l) => l.objectId),
    ["1", "22", "49", "12", "10", "73"],
  );
  assert.deepEqual(
    tree.map((l) => l.z),
    [0, 1, 7, 9, 15, 29],
  );
});

test("buildLayerTree 子节点 index 小于父组时仍按兄弟排序（不能拿 index 判父子）", () => {
  // 实测：父组 index=29，子节点却是 24–28
  const nodes = [
    node({ object_id: "73", index: 29, type: "group" }),
    node({ object_id: "16", parent_id: "73", index: 24 }),
    node({ object_id: "17", parent_id: "73", index: 25 }),
    node({ object_id: "9", index: 9 }),
  ];

  const tree = buildLayerTree(nodes, "root");
  assert.deepEqual(
    tree.map((l) => l.objectId),
    ["9", "73"],
  );
  assert.deepEqual(
    tree[1].children?.map((c) => c.objectId),
    ["16", "17"],
  );
});

test("buildLayerTree 缺 index 时保持原数组顺序（老数据兼容）", () => {
  const nodes = [
    node({ object_id: "a", index: undefined }),
    node({ object_id: "b", index: undefined }),
    node({ object_id: "c", index: undefined }),
  ];
  const tree = buildLayerTree(nodes, "root");
  assert.deepEqual(
    tree.map((l) => l.objectId),
    ["a", "b", "c"],
  );
});

// ---------------------------------------------------------------------------
// 数值字段 {value, units} 解包 —— font-size: NaNpx 的根因
// ---------------------------------------------------------------------------

/** 造一个带文本样式的原始节点 */
function textNode(textStyle: Record<string, any>, over: Record<string, any> = {}) {
  return node({
    type: "text",
    object_id: "t1",
    text: { textKey: "文案", textStyleRange: [{ textStyle }] },
    ...over,
  });
}

test("文本字号支持 {value, units} 形态（回归：NaNpx）", () => {
  const tree = buildLayerTree(
    [textNode({ impliedFontSize: { value: 24, units: "pointsUnit" } })],
    "root",
  );
  assert.equal(tree[0].text?.size, 24);
});

test("文本字号优先 impliedFontSize 而非排版原始 size", () => {
  // 实测同一层 size.value=55.89 是排版值，impliedFontSize.value=22 才是渲染值
  const tree = buildLayerTree(
    [
      textNode({
        size: { value: 55.8918, units: "pointsUnit" },
        impliedFontSize: { value: 22, units: "pointsUnit" },
      }),
    ],
    "root",
  );
  assert.equal(tree[0].text?.size, 22);
});

test("文本行高同样支持 {value, units}", () => {
  const tree = buildLayerTree(
    [textNode({ impliedFontSize: { value: 22 }, impliedLeading: { value: 30, units: "pointsUnit" } })],
    "root",
  );
  assert.equal(tree[0].text?.lineHeight, 30);
});

test("字号全部缺失时 spec 不再输出 NaNpx", () => {
  // 源数据既没有 impliedFontSize 也没有 fontSize/size —— 旧实现会算出 undefined * scale = NaN
  const legacy: Layer = {
    id: "t1",
    objectId: "t1",
    name: "文案",
    type: "text",
    rect: { x: 0, y: 0, width: 100, height: 20 },
    visible: true,
    text: { fontName: "SimHei", fontStyleName: "Regular", size: 0, content: "文案" },
  };
  const spec = buildSpec(screen, { name: "s", width: 750, height: 1612, layers: [legacy] }, []);
  const style = spec.nodes[0].style.join("; ");
  assert.ok(!/NaN/.test(style), "style 里不应出现 NaN: " + style);
});

// ---------------------------------------------------------------------------
// 文本对齐：权威来源是 paragraphStyleRange
// ---------------------------------------------------------------------------

test("文本对齐优先读 paragraphStyleRange.align", () => {
  const tree = buildLayerTree(
    [
      textNode(
        { impliedFontSize: { value: 22 } },
        {
          textAlign: "left",
          text: {
            textKey: "文案",
            textStyleRange: [{ textStyle: { impliedFontSize: { value: 22 } } }],
            paragraphStyleRange: [{ paragraphStyle: { align: "center" } }],
          },
        },
      ),
    ],
    "root",
  );
  assert.equal(tree[0].text?.textAlign, "center");
});

test("没有 paragraphStyleRange 时回退图层级 textAlign", () => {
  const tree = buildLayerTree(
    [textNode({ impliedFontSize: { value: 22 } }, { textAlign: "right" })],
    "root",
  );
  assert.equal(tree[0].text?.textAlign, "right");
});

test("段落对齐会出现在 spec 的 style 串里", () => {
  const layer: Layer = {
    id: "t1",
    objectId: "t1",
    name: "文案",
    type: "text",
    rect: { x: 0, y: 0, width: 100, height: 20 },
    visible: true,
    text: { fontName: "SimHei", fontStyleName: "Regular", size: 22, textAlign: "center" },
  };
  const spec = buildSpec(screen, { name: "s", width: 750, height: 1612, layers: [layer] }, []);
  assert.match(spec.nodes[0].style.join("; "), /text-align:center/);
});

// ---------------------------------------------------------------------------
// 盒子可信度
// ---------------------------------------------------------------------------

test("空组 rect 用可见子层并集推导并标低可信", () => {
  const nodes = [
    node({ object_id: "311", index: 0, type: "group", rect: { x: 0, y: 0, width: 0, height: 0 } }),
    node({ object_id: "a", index: 1, parent_id: "311", rect: { x: 10, y: 20, width: 100, height: 50 } }),
    node({ object_id: "b", index: 2, parent_id: "311", rect: { x: 50, y: 40, width: 100, height: 50 } }),
  ];
  const tree = buildLayerTree(nodes, "root");
  assert.equal(tree[0].rectConfidence, "low");
  assert.deepEqual(tree[0].sliceRect, { x: 10, y: 20, width: 140, height: 70 });
});

test("子层溢出父组时组 rect 标低可信并给出推定框", () => {
  // 实测：子 368 报 750×1612，父组 764 只报 388×180
  const nodes = [
    node({ object_id: "764", index: 0, type: "group", rect: { x: 0, y: 0, width: 388, height: 180 } }),
    node({ object_id: "368", index: 1, parent_id: "764", rect: { x: 0, y: 0, width: 750, height: 1612 } }),
  ];
  const tree = buildLayerTree(nodes, "root");
  assert.equal(tree[0].rectConfidence, "low");
  assert.deepEqual(tree[0].sliceRect, { x: 0, y: 0, width: 750, height: 1612 });
});

test("正常盒子不会被标低可信", () => {
  const nodes = [
    node({ object_id: "g", index: 0, type: "group", rect: { x: 0, y: 0, width: 200, height: 200 } }),
    node({ object_id: "c", index: 1, parent_id: "g", rect: { x: 10, y: 10, width: 100, height: 100 } }),
  ];
  const tree = buildLayerTree(nodes, "root");
  assert.equal(tree[0].rectConfidence, undefined);
  assert.equal(tree[0].sliceRect, undefined);
});

// ---------------------------------------------------------------------------
// 切图数量：接口元数据不可信
// ---------------------------------------------------------------------------

test("getScreen 保留接口原始 slices_count 到 slicesCountReported", async (t) => {
  const client = new CoDesignClient("access_token=abc");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        id: 100,
        name: "h5",
        width: 750,
        height: 1612,
        slices_count: 0,
        preview_path: "/p.png",
        original_path: "/o.png",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const detail = await client.getScreen(10, 100);
  assert.equal(detail.slicesCountReported, 0);
  assert.equal(detail.originalUrl, "https://cdn4.codesign.qq.com/o.png");
});
