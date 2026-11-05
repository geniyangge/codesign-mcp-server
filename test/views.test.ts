import assert from "node:assert/strict";
import { test } from "node:test";

import { assignRefs, collectUnreconstructable, flattenWithMeta, matchLayersByName, projectLayers } from "../src/views.js";
import type { Layer } from "../src/types.js";

function layer(over: Partial<Layer> = {}): Layer {
  return {
    id: "1",
    objectId: "1",
    name: "图层",
    type: "shape",
    rect: { x: 10, y: 20, width: 100, height: 50 },
    visible: true,
    ...over,
  };
}

/** 三层结构：group > [text, group2 > shape] */
function tree(): Layer[] {
  return [
    layer({
      objectId: "g1",
      parentId: "root",
      name: "组一",
      type: "group",
      z: 0,
      children: [
        layer({ objectId: "t1", parentId: "g1", name: "标题", type: "text", z: 1, text: { fontName: "SimHei", fontStyleName: "Regular", size: 22, content: "你好" } }),
        layer({
          objectId: "g2",
          parentId: "g1",
          name: "组二",
          type: "group",
          z: 2,
          children: [layer({ objectId: "s1", parentId: "g2", name: "底图", type: "shape", z: 3 })],
        }),
      ],
    }),
  ];
}

test("summary 视图只给定位所需字段，不带样式", () => {
  const r = projectLayers(tree(), { view: "summary" });
  const found = r.layers.find((l) => l.objectId === "t1")!;
  assert.equal(found.type, "text");
  assert.deepEqual(found.rect, { x: 10, y: 20, width: 100, height: 50 });
  assert.equal(found.z, 1);
  assert.equal(found.parentId, "g1");
  assert.equal(found.depth, 1);
  assert.deepEqual(found.flags, ["text"]);
  assert.equal(found.text, undefined, "summary 不应带 text 对象");
  assert.equal(found.css, undefined);
});

test("层级用 depth/parentId 表达，不再往 name 里塞空格", () => {
  const r = projectLayers(tree(), { view: "summary" });
  const title = r.layers.find((l) => l.objectId === "t1")!;
  assert.equal(title.name, "标题", "name 必须是原名，不带缩进");
  assert.equal(title.depth, 1);
  assert.equal(title.parentId, "g1");
  const deep = r.layers.find((l) => l.objectId === "s1")!;
  assert.equal(deep.depth, 2);
  assert.equal(deep.parentId, "g2");
});

test("flat 视图补上样式细节", () => {
  const withCss = [layer({ objectId: "a", css: ["background: #fff"], radius: [4, 4, 4, 4], opacity: 0.5 })];
  const r = projectLayers(withCss, { view: "flat" });
  assert.deepEqual(r.layers[0].css, ["background: #fff"]);
  assert.deepEqual(r.layers[0].radius, [4, 4, 4, 4]);
  assert.equal(r.layers[0].opacity, 0.5);
});

test("tree 视图保留嵌套", () => {
  const r = projectLayers(tree(), { view: "tree" });
  assert.equal(r.tree?.length, 1);
  const g1 = r.tree![0] as any;
  assert.equal(g1.objectId, "g1");
  assert.equal(g1.children.length, 2);
  assert.equal(g1.children[1].children[0].objectId, "s1");
});

test("types 过滤只保留指定类型", () => {
  const r = projectLayers(tree(), { types: ["text"] });
  assert.deepEqual(
    r.layers.map((l) => l.objectId),
    ["t1"],
  );
  assert.equal(r.filtered, 3);
});

test("subtreeId 只取该子树", () => {
  const r = projectLayers(tree(), { subtreeId: "g2" });
  assert.deepEqual(
    r.layers.map((l) => l.objectId),
    ["g2", "s1"],
  );
  // 子树内的深度从 0 重新计
  assert.equal(r.layers[0].depth, 0);
  assert.equal(r.layers[1].depth, 1);
});

test("subtreeId 不存在时返回空而不是抛错", () => {
  const r = projectLayers(tree(), { subtreeId: "nope" });
  assert.deepEqual(r.layers, []);
  assert.equal(r.paging.total, 0);
});

test("分页给出 offset/limit/total/hasMore", () => {
  const r = projectLayers(tree(), { offset: 1, limit: 2 });
  assert.equal(r.layers.length, 2);
  assert.deepEqual(r.paging, { offset: 1, limit: 2, total: 4, hasMore: true });
  assert.deepEqual(
    r.layers.map((l) => l.objectId),
    ["t1", "g2"],
  );
});

test("fields 投影只保留指定字段，但 objectId 永远保留", () => {
  const r = projectLayers(tree(), { fields: ["rect", "name"] });
  const first = r.layers[0];
  assert.deepEqual(Object.keys(first).sort(), ["name", "objectId", "rect"]);
});

test("低可信盒子会带上 sliceRect 提示", () => {
  const bad = [layer({ objectId: "x", rectConfidence: "low", rect: { x: 0, y: 0, width: 0, height: 0 }, sliceRect: { x: 5, y: 6, width: 70, height: 80 } })];
  const r = projectLayers(bad, {});
  assert.equal(r.layers[0].rectConfidence, "low");
  assert.deepEqual(r.layers[0].rect, { x: 5, y: 6, width: 70, height: 80 }, "rect 用推定框");
  assert.deepEqual(r.layers[0].sliceRect, { x: 5, y: 6, width: 70, height: 80 });
});

test("图层标记覆盖位图、切图、隐藏、矢量", () => {
  const layers = [
    layer({ objectId: "a", isBitmap: true }),
    layer({ objectId: "b", isBitmap: true, slice: { objectId: "b", scales: [2], formats: ["png"], exportWidth: 200, exportHeight: 100 } }),
    layer({ objectId: "c", visible: false }),
    layer({ objectId: "d", isVector: true }),
  ];
  const r = projectLayers(layers, {});
  assert.deepEqual(r.layers[0].flags, ["bitmap:no-slice"]);
  assert.deepEqual(r.layers[1].flags, ["bitmap:slice"]);
  assert.deepEqual(r.layers[2].flags, ["hidden"]);
  assert.deepEqual(r.layers[3].flags, ["vector"]);
});

test("collectUnreconstructable 返回完整列表而不是只举例", () => {
  const many = Array.from({ length: 42 }, (_, i) => layer({ objectId: `b${i}`, name: `位图${i}`, isBitmap: true }));
  const out = collectUnreconstructable(many);
  assert.equal(out.length, 42);
  assert.equal(out[0].objectId, "b0");
  assert.match(out[0].reason, /位图/);
  assert.match(out[0].fallback, /design_export/);
});

test("collectUnreconstructable 跳过有切图的和隐藏的", () => {
  const layers = [
    layer({ objectId: "a", isBitmap: true, slice: { objectId: "a", scales: [2], formats: ["png"], exportWidth: 1, exportHeight: 1 } }),
    layer({ objectId: "b", isBitmap: true, visible: false }),
    layer({ objectId: "c", isBitmap: true }),
  ];
  const out = collectUnreconstructable(layers);
  assert.deepEqual(
    out.map((x) => x.objectId),
    ["c"],
  );
});

test("collectUnreconstructable 对空盒子给出不同兜底建议", () => {
  const out = collectUnreconstructable([
    layer({ objectId: "z", isBitmap: true, rect: { x: 0, y: 0, width: 0, height: 0 } }),
  ]);
  assert.match(out[0].fallback, /补切图/);
});

test("assignRefs 给每层分配稳定短标识", () => {
  const refs = flattenWithMeta(assignRefs(tree())).map(({ layer }) => layer.ref);
  assert.deepEqual(refs, ["L1", "L2", "L3", "L4"]);
});

test("flattenWithMeta 带出父节点链", () => {
  const flat = flattenWithMeta(tree());
  assert.deepEqual(
    flat.map(({ layer, depth, parentId }) => `${layer.objectId}@${depth}<-${parentId}`),
    ["g1@0<-root", "t1@1<-g1", "g2@1<-g1", "s1@2<-g2"],
  );
});

// ---------------------------------------------------------------------------
// 建议导出区域与名字匹配
// ---------------------------------------------------------------------------

test("collectUnreconstructable 给出 suggestedRegion 可直接用于 design_export", () => {
  const [r] = collectUnreconstructable([
    layer({ objectId: "b1", name: "位图", isBitmap: true, rect: { x: 12.6, y: 30.2, width: 99.4, height: 50.8 } }),
  ]);
  assert.deepEqual(r.suggestedRegion, { objectId: "b1", x: 13, y: 30, width: 99, height: 51 });
  assert.match(r.fallback, /regions/);
});

test("盒子为空的图层不给 suggestedRegion", () => {
  const [r] = collectUnreconstructable([
    layer({ objectId: "z", isBitmap: true, rect: { x: 0, y: 0, width: 0, height: 0 } }),
  ]);
  assert.equal(r.suggestedRegion, undefined);
  assert.match(r.fallback, /补切图/);
});

test("matchLayersByName 按正则批量匹配并按 z 排序", () => {
  const layers = [
    layer({ objectId: "a", name: "图标_关闭", z: 5 }),
    layer({ objectId: "b", name: "按钮_确定", z: 2 }),
    layer({ objectId: "c", name: "图标_打开", z: 9 }),
  ];
  const out = matchLayersByName(layers, "图标");
  assert.deepEqual(
    out.map((m) => m.objectId),
    ["a", "c"],
    "按 z 升序",
  );
});

test("matchLayersByName 不区分大小写", () => {
  const out = matchLayersByName([layer({ objectId: "a", name: "Icon_Home" })], "icon");
  assert.equal(out.length, 1);
});

test("matchLayersByName 支持类型过滤", () => {
  const layers = [
    layer({ objectId: "a", name: "图标", type: "shape" }),
    layer({ objectId: "b", name: "图标", type: "group" }),
  ];
  const out = matchLayersByName(layers, "图标", { types: ["group"] });
  assert.deepEqual(
    out.map((m) => m.objectId),
    ["b"],
  );
});

test("matchLayersByName 跳过隐藏图层", () => {
  const out = matchLayersByName([layer({ objectId: "a", name: "图标", visible: false })], "图标");
  assert.equal(out.length, 0);
});

test("matchLayersByName 非法正则抛出可读错误", () => {
  assert.throws(() => matchLayersByName([], "["), /不是合法的正则表达式/);
});

test("matchLayersByName 标出图层是否有切图", () => {
  const out = matchLayersByName(
    [
      layer({ objectId: "a", name: "图标", slice: { objectId: "a", scales: [2], formats: ["png"], exportWidth: 1, exportHeight: 1 } }),
      layer({ objectId: "b", name: "图标2" }),
    ],
    "图标",
  );
  assert.deepEqual(
    out.map((m) => m.hasSlice),
    [true, false],
  );
});
