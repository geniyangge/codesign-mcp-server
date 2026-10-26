import assert from "node:assert/strict";
import { test } from "node:test";

import { CoDesignClient } from "../src/client.js";
import { buildSpec } from "../src/spec.js";
import { attachSlices } from "../src/tools.js";
import type { Layer, LayerTree, ScreenDetail, SliceItem } from "../src/types.js";

// 位图图层的处理：设计稿对这类图层只给盒子尺寸和 css，
// 没有 fills/borders/effects，必须靠切图还原，或者明确告诉调用方「做不到」。

const screen: ScreenDetail = {
  id: 1,
  name: "示例画板",
  width: 750,
  height: 1334,
  designId: 2,
  source: "",
  slicesCount: 0,
};

function layer(partial: Partial<Layer>): Layer {
  return {
    id: "1",
    objectId: "1",
    name: "layer",
    type: "shape",
    rect: { x: 0, y: 0, width: 750, height: 3287 },
    visible: true,
    ...partial,
  };
}

function slice(id: string, name: string, scales: number[]): SliceItem {
  return {
    id,
    name,
    rect: { x: 0, y: 0, width: 750, height: 3287 },
    exports: scales.map((s) => ({
      name,
      scale: s,
      format: "png",
      width: 750 * s,
      height: 3287 * s,
      downloadUrl: `u${s}`,
      objectId: id,
    })),
  };
}

test("attachSlices 按 object_id 把切图挂到图层上", () => {
  const layers = [layer({ objectId: "132", name: "底图", isBitmap: true })];
  const [linked] = attachSlices(layers, [slice("132", "底图", [2, 3])]);

  assert.ok(linked.slice, "应挂上切图信息");
  assert.deepEqual(linked.slice.scales, [2, 3]);
  assert.deepEqual(linked.slice.formats, ["png"]);
  // 取最高倍率的实际导出尺寸
  assert.equal(linked.slice.exportWidth, 2250);
  assert.equal(linked.slice.exportHeight, 9861);
});

test("attachSlices 递归处理子图层", () => {
  const tree = [
    layer({
      objectId: "g",
      type: "group",
      children: [layer({ objectId: "c", name: "子", isBitmap: true })],
    }),
  ];
  const [linked] = attachSlices(tree, [slice("c", "子", [2])]);
  assert.equal(linked.slice, undefined, "组本身没有切图");
  assert.ok(linked.children?.[0].slice, "子图层应被关联");
});

test("attachSlices 没有切图清单时原样返回", () => {
  const layers = [layer({ objectId: "132", isBitmap: true })];
  const out = attachSlices(layers, []);
  assert.equal(out[0].slice, undefined);
});

test("位图图层带切图时，spec 标记 bitmap:slice 并提示用切图还原", () => {
  const tree: LayerTree = {
    name: "画板",
    width: 750,
    height: 3287,
    layers: [layer({ objectId: "132", name: "底图", isBitmap: true })],
  };
  const linked = attachSlices(tree.layers, [slice("132", "底图", [3])]);
  const spec = buildSpec(screen, { ...tree, layers: linked }, [slice("132", "底图", [3])], {});

  const node = spec.nodes[0];
  assert.ok(node.style.includes("bitmap:slice"), `缺少位图标记: ${JSON.stringify(node.style)}`);
  assert.ok(
    spec.notes.some((n) => n.includes("位图图层有切图")),
    `缺少切图提示: ${JSON.stringify(spec.notes)}`,
  );
});

test("位图图层没有切图时，spec 标记 bitmap:no-slice 并说明无法还原", () => {
  const tree: LayerTree = {
    name: "画板",
    width: 750,
    height: 3287,
    layers: [layer({ objectId: "132", name: "底图", isBitmap: true })],
  };
  const spec = buildSpec(screen, tree, [], {});

  const node = spec.nodes[0];
  assert.ok(node.style.includes("bitmap:no-slice"), `缺少标记: ${JSON.stringify(node.style)}`);
  const note = spec.notes.find((n) => n.includes("既没有矢量信息也没有切图"));
  assert.ok(note, `应提示无法还原: ${JSON.stringify(spec.notes)}`);
  assert.match(note!, /底图/);
  assert.match(note!, /750×3287/);
});

test("位图图层识别：pixels / image 填充 / path 的区分", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        name: "画板",
        width: 750,
        height: 1334,
        object_id: "100",
        layers: [
          // 位图：带 pixels
          { object_id: "1", parent_id: "100", type: "shape", name: "有pixels", rect: { x: 0, y: 0, width: 1, height: 1 }, pixels: { w: 1 } },
          // 位图：图片填充
          {
            object_id: "2",
            parent_id: "100",
            type: "shape",
            name: "图片填充",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            fills: [{ fillType: "image" }],
          },
          // 矢量：带 path，即使也有 pixels 也算矢量
          {
            object_id: "3",
            parent_id: "100",
            type: "shape",
            name: "矢量",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            path: { pathComponents: [] },
            pixels: { w: 1 },
          },
          // 位图：智能对象（线上实测最常见的形态，既无 pixels 也无 fills）
          {
            object_id: "5",
            parent_id: "100",
            type: "shape",
            _type: "shapeLayer",
            name: "智能对象",
            rect: { x: 0, y: 0, width: 750, height: 3287 },
            smartObject: { ID: "abc", placed: "def", crop: 1, type: 2 },
            css: ["width:750px", "height:3287px"],
          },
          // 普通形状
          {
            object_id: "4",
            parent_id: "100",
            type: "shape",
            name: "普通",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            fills: [{ fillType: "color", color: { r: 0, g: 0, b: 0, a: 1 } }],
          },
        ],
        groups: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const client = new CoDesignClient("");
  const tree = await client.getMeta("https://cdn4.codesign.qq.com/meta.json");
  const byName = new Map(tree.layers.map((l) => [l.name, l]));

  assert.equal(byName.get("有pixels")?.isBitmap, true);
  assert.equal(byName.get("图片填充")?.isBitmap, true);
  // 智能对象同样没有矢量信息，必须识别为位图
  assert.equal(byName.get("智能对象")?.isBitmap, true);
  // 有 path 的一律按矢量处理，不当位图
  assert.equal(byName.get("矢量")?.isBitmap, undefined);
  assert.equal(byName.get("矢量")?.isVector, true);
  assert.equal(byName.get("普通")?.isBitmap, undefined);
});
