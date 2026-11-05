import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSpec } from "../src/spec.js";
import { pickExports } from "../src/tools.js";
import type { Layer, LayerTree, ScreenDetail, SliceItem } from "../src/types.js";
import { createNamer } from "../src/utils/filename.js";

const screen: ScreenDetail = {
  id: 1,
  name: "首页",
  width: 750,
  height: 1334,
  designId: 2,
  source: "",
  slicesCount: 1,
};

function layer(partial: Partial<Layer>): Layer {
  return {
    id: "1",
    objectId: "1",
    name: "layer",
    type: "shape",
    rect: { x: 0, y: 0, width: 100, height: 50 },
    visible: true,
    ...partial,
  };
}

function tree(layers: Layer[]): LayerTree {
  return { name: "首页", width: 750, height: 1334, layers };
}

test("buildSpec 默认按 750→375 换算坐标与字号", () => {
  const spec = buildSpec(
    screen,
    tree([
      layer({
        type: "text",
        rect: { x: 40, y: 100, width: 200, height: 60 },
        text: {
          fontName: "PingFang SC",
          fontStyleName: "Regular",
          size: 32,
          color: "#333333",
          content: "标题",
        },
      }),
    ]),
    [],
  );

  assert.equal(spec.scale, 0.5);
  assert.deepEqual(spec.nodes[0].box, { left: 20, top: 50, width: 100, height: 30 });

  // 文本样式合成一条 CSS 字符串，方便直接粘到样式表里
  const css = spec.nodes[0].style.join("; ");
  assert.match(css, /font-size:16\.00px/);
  assert.match(css, /color:#333333/);
  assert.match(css, /font-family:"PingFang SC"/);
  assert.equal(spec.nodes[0].text, "标题");
});

test("buildSpec 传 cssWidth 750 时保持原始 px", () => {
  const spec = buildSpec(
    screen,
    tree([layer({ rect: { x: 40, y: 100, width: 200, height: 60 } })]),
    [],
    750,
  );
  assert.equal(spec.scale, 1);
  assert.deepEqual(spec.nodes[0].box, { left: 40, top: 100, width: 200, height: 60 });
});

test("buildSpec 过滤不可见图层", () => {
  const spec = buildSpec(
    screen,
    tree([layer({ name: "show" }), layer({ name: "hide", visible: false })]),
    [],
  );
  assert.equal(spec.nodes.length, 1);
  assert.match(spec.nodes[0].name, /show/);
});

test("buildSpec 按 maxLayers 截断并给出说明", () => {
  const layers = Array.from({ length: 10 }, (_, i) => layer({ name: `l${i}` }));
  const spec = buildSpec(screen, tree(layers), [], { maxLayers: 3 });

  assert.equal(spec.nodes.length, 3);
  assert.deepEqual(spec.truncated, { total: 10, returned: 3 });
  assert.ok(spec.notes.some((n) => n.includes("仅输出前 3 个")));
});

test("buildSpec 按 maxDepth 截断子树", () => {
  const deep = layer({
    name: "root",
    children: [layer({ name: "child", children: [layer({ name: "grandchild" })] })],
  });
  const spec = buildSpec(screen, tree([deep]), [], { maxDepth: 1 });
  assert.deepEqual(
    spec.nodes.map((n) => n.name.trim()),
    ["root", "child"],
  );
});

test("buildSpec 的切图文件名带倍率后缀且与下载共用命名器", () => {
  const slices: SliceItem[] = [
    {
      id: "a",
      name: "icon/home",
      rect: { x: 0, y: 0, width: 40, height: 40 },
      exports: [{ name: "x", scale: 2, format: "png", width: 80, height: 80, downloadUrl: "", objectId: "" }],
    },
    {
      id: "b",
      name: "icon/home",
      rect: { x: 0, y: 60, width: 40, height: 40 },
      exports: [{ name: "y", scale: 2, format: "png", width: 80, height: 80, downloadUrl: "", objectId: "" }],
    },
  ];

  const spec = buildSpec(screen, tree([]), slices, { namer: createNamer() });
  assert.deepEqual(
    spec.slices.map((s) => s.file),
    ["icon_home@2x.png", "icon_home@2x_2.png"],
  );
});

test("buildSpec 每个图层只输出被选中的那一档倍率", () => {
  // 回归：旧实现把同一图层所有倍率都列出来并各分配文件名，
  // 但下载只挑一档，导致 spec 提示的文件名在实际落盘里根本不存在
  const multi: SliceItem[] = [
    {
      id: "a",
      name: "多倍率",
      rect: { x: 0, y: 0, width: 40, height: 40 },
      exports: [
        { name: "1x", scale: 1, format: "png", width: 40, height: 40, downloadUrl: "", objectId: "a" },
        { name: "2x", scale: 2, format: "png", width: 80, height: 80, downloadUrl: "", objectId: "a" },
        { name: "3x", scale: 3, format: "png", width: 120, height: 120, downloadUrl: "", objectId: "a" },
      ],
    },
  ];
  const spec = buildSpec(screen, tree([]), multi, { namer: createNamer(), scale: { kind: "design", scale: 2 } });
  assert.equal(spec.slices.length, 1, "只应输出被选中的那一档");
  assert.equal(spec.slices[0].file, "多倍率@2x.png");
  assert.equal(spec.slices[0].exportScale, 2);
});

test("buildSpec 输出圆角、透明度与旋转", () => {
  const spec = buildSpec(
    screen,
    tree([layer({ radius: [8, 8, 0, 0], opacity: 0.5, rotation: 45 })]),
    [],
  );
  const style = spec.nodes[0].style.join("; ");
  assert.match(style, /border-radius:4\.00px 4\.00px 0\.00px 0\.00px/);
  assert.match(style, /opacity:0\.5/);
  assert.match(style, /rotate\(45deg\)/);
});

const mkSlice = (scales: number[]): SliceItem => ({
  id: "1",
  name: "icon",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  exports: scales.map((s) => ({
    name: "icon",
    scale: s,
    format: "png",
    width: 10 * s,
    height: 10 * s,
    downloadUrl: `u${s}`,
    objectId: "",
  })),
});

test("pickExports 默认取 2 倍图", () => {
  // 有 2x 时直接命中，即使存在更高的 3x
  assert.deepEqual(pickExports(mkSlice([1, 2, 3])).map((p) => p.export.scale), [2]);
  assert.equal(pickExports(mkSlice([1, 2, 3]))[0].substituted, false);
});

test("pickExports 用户指定的倍率优先于默认值", () => {
  const item = mkSlice([1, 2, 3]);
  // 用户说「要 3 倍图」
  assert.deepEqual(pickExports(item, 3).map((p) => p.export.scale), [3]);
  assert.equal(pickExports(item, 3)[0].substituted, false);
  // 用户说「要 1 倍图」
  assert.deepEqual(pickExports(item, 1).map((p) => p.export.scale), [1]);
});

test("pickExports 缺少目标倍率时就近取，并标记 substituted", () => {
  // 只有 3x，要 2x → 向上取 3x
  const only3 = pickExports(mkSlice([3]));
  assert.deepEqual(only3.map((p) => p.export.scale), [3]);
  assert.equal(only3[0].substituted, true);

  // 有 1x 和 3x，要 2x → 取不超过目标的最高档 1x
  const oneThree = pickExports(mkSlice([1, 3]));
  assert.deepEqual(oneThree.map((p) => p.export.scale), [1]);
  assert.equal(oneThree[0].substituted, true);

  // 用户要 4x 但只有 2x/3x → 取 3x，并标记替换
  const up = pickExports(mkSlice([2, 3]), 4);
  assert.deepEqual(up.map((p) => p.export.scale), [3]);
  assert.equal(up[0].substituted, true);
});

test("pickExports 空导出返回空数组", () => {
  assert.deepEqual(pickExports(mkSlice([])), []);
});

test("文本图层输出 typography 排版信息", () => {
  const t: Layer = {
    id: "t1",
    objectId: "t1",
    name: "说明",
    type: "text",
    rect: { x: 0, y: 0, width: 200, height: 60 },
    visible: true,
    text: {
      fontName: "SimHei",
      fontStyleName: "Regular",
      size: 24,
      leading: 36,
      letterSpacing: 1,
      textAlign: "center",
      content: "第一行\n第二行",
    },
  };
  const spec = buildSpec(screen, { name: "s", width: 750, height: 1612, layers: [t] }, []);
  const ty = spec.nodes[0].typography!;
  // 750 → 375 是一半
  assert.equal(ty.fontSize, 12);
  assert.equal(ty.lineHeight, 18);
  assert.equal(ty.letterSpacing, 0.5);
  assert.equal(ty.fontWeight, "400");
  assert.equal(ty.textAlign, "center");
  assert.deepEqual(ty.lines, ["第一行", "第二行"]);
  assert.equal(ty.boxHeight, 30);
});

test("单行文本不输出 lines", () => {
  const t: Layer = {
    id: "t1",
    objectId: "t1",
    name: "标题",
    type: "text",
    rect: { x: 0, y: 0, width: 100, height: 20 },
    visible: true,
    text: { fontName: "SimHei", fontStyleName: "Bold", size: 22, content: "单行" },
  };
  const spec = buildSpec(screen, { name: "s", width: 750, height: 1612, layers: [t] }, []);
  assert.equal(spec.nodes[0].typography!.lines, undefined);
  assert.equal(spec.nodes[0].typography!.fontWeight, "700");
});

test("非文本图层不输出 typography", () => {
  const s: Layer = {
    id: "s1",
    objectId: "s1",
    name: "方块",
    type: "shape",
    rect: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
  };
  const spec = buildSpec(screen, { name: "s", width: 750, height: 1612, layers: [s] }, []);
  assert.equal(spec.nodes[0].typography, undefined);
});
