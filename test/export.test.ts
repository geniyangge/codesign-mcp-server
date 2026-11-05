import assert from "node:assert/strict";
import { test } from "node:test";

import { planLayerExports, planRegionExports, summarizeTiers } from "../src/export.js";
import { createNamer } from "../src/utils/filename.js";
import type { Layer, ScreenDetail, SliceItem } from "../src/types.js";

const screen: ScreenDetail = {
  id: 100,
  name: "h5",
  width: 750,
  height: 1612,
  designId: 2,
  source: "",
  slicesCount: 13,
  originalUrl: "https://cdn4.codesign.qq.com/full.png?imageMogr2/format/png",
};

function layer(over: Partial<Layer> = {}): Layer {
  return {
    id: "12",
    objectId: "12",
    name: "图层 12",
    type: "shape",
    rect: { x: 0, y: 556, width: 750, height: 1056 },
    visible: true,
    z: 9,
    ...over,
  };
}

function sliceFor(objectId: string, over: Partial<SliceItem> = {}): SliceItem {
  return {
    id: objectId,
    objectId,
    name: "图层 12",
    rect: { x: 0, y: 556, width: 750, height: 1056 },
    exports: [
      {
        name: "图层 12",
        scale: 3,
        format: "png",
        width: 2250,
        height: 3168,
        downloadUrl: "https://cdn4.codesign.qq.com/s.png?imageMogr2/format/png",
        objectId,
      },
    ],
    ...over,
  };
}

/** 命名器有状态（记录已分配的名字），每个用例都要新建一份 */
const freshOpts = () => ({ namer: createNamer(), scale: { kind: "design", scale: 2 } as const });
const base = freshOpts();

test("有切图的图层走 slice 层级且不透明标记为 false", () => {
  const [p] = planLayerExports(["12"], [layer()], [sliceFor("12")], screen, base);
  assert.equal(p.tier, "slice");
  assert.equal(p.opaque, false);
  assert.equal(p.exportScale, 3);
  assert.equal(p.targetScale, 2);
  assert.equal(p.resampled, true);
  // 750 × 2
  assert.equal(p.width, 1500);
  assert.match(p.downloadUrl, /thumbnail\/1500x/);
});

test("没有切图但有盒子的图层降级为从合成图裁剪", () => {
  const [p] = planLayerExports(["12"], [layer()], [], screen, base);
  assert.equal(p.tier, "composite");
  assert.equal(p.opaque, true, "裁剪合成图会带上底层内容");
  assert.match(p.downloadUrl, /cut\/750x1056x0x556/);
  assert.match(p.downloadUrl, /thumbnail\/1500x/);
  assert.equal(p.width, 1500);
});

test("composite 文件名带 _composite 以示区分", () => {
  // 每个用例用独立命名器，避免被前一个用例的分配记录影响
  const [p] = planLayerExports(["12"], [layer()], [], screen, { namer: createNamer(), scale: { kind: "design", scale: 2 } });
  assert.equal(p.file, "图层 12_composite@2x.png");
});

test("没有切图且盒子为 0x0 时标记 fail 并给出原因", () => {
  const empty = layer({ rect: { x: 0, y: 0, width: 0, height: 0 } });
  const [p] = planLayerExports(["12"], [empty], [], screen, base);
  assert.equal(p.tier, "fail");
  assert.equal(p.downloadUrl, "");
  assert.match(p.reason ?? "", /补切图/);
});

test("盒子为 0x0 但有 sliceRect 时用 sliceRect 裁剪", () => {
  const fixed = layer({
    rect: { x: 0, y: 0, width: 0, height: 0 },
    rectConfidence: "low",
    sliceRect: { x: 10, y: 20, width: 100, height: 50 },
  });
  const [p] = planLayerExports(["12"], [fixed], [], screen, base);
  assert.equal(p.tier, "composite");
  assert.deepEqual(p.rect, { x: 10, y: 20, width: 100, height: 50 });
  assert.equal(p.width, 200);
});

test("不存在的 objectId 标记 fail 并提示先查 design_get", () => {
  const [p] = planLayerExports(["999"], [], [], screen, base);
  assert.equal(p.tier, "fail");
  assert.match(p.reason ?? "", /objectId/);
});

test("画板没有原图时 composite 标记 fail", () => {
  const noImage = { ...screen, originalUrl: undefined };
  const [p] = planLayerExports(["12"], [layer()], [], noImage, base);
  assert.equal(p.tier, "fail");
  assert.match(p.reason ?? "", /原图/);
});

test("planRegionExports 按设计稿坐标裁剪", () => {
  const [p] = planRegionExports([{ name: "横幅", x: 0, y: 0, width: 750, height: 1141 }], screen, base);
  assert.equal(p.tier, "composite");
  assert.match(p.downloadUrl, /cut\/750x1141x0x0/);
  assert.match(p.downloadUrl, /thumbnail\/1500x/);
  assert.equal(p.width, 1500);
  assert.equal(p.height, Math.round((1141 / 750) * 1500));
});

test("region 的 ref 用 e 前缀以便与切图的 s 前缀区分", () => {
  const plans = planRegionExports(
    [
      { name: "a", x: 0, y: 0, width: 100, height: 100 },
      { name: "b", x: 0, y: 200, width: 100, height: 100 },
    ],
    screen,
    base,
  );
  assert.deepEqual(
    plans.map((p) => p.ref),
    ["e1", "e2"],
  );
});

test("summarizeTiers 统计三个层级", () => {
  const plans = planLayerExports(
    ["12", "13", "999"],
    [
      layer(),
      layer({ objectId: "13", id: "13", name: "空组", rect: { x: 0, y: 0, width: 0, height: 0 } }),
    ],
    [sliceFor("12")],
    screen,
    freshOpts(),
  );
  const s = summarizeTiers(plans);
  assert.equal(s.slice, 1);
  assert.equal(s.fail, 2, "空盒子与不存在的 objectId 都算导出失败");
});

test("指定 targetWidth 时优先于 scale", () => {
  const [p] = planLayerExports(["12"], [layer()], [sliceFor("12")], screen, {
    namer: createNamer(),
    scale: { kind: "design", scale: 3 },
    targetWidth: 300,
  });
  assert.equal(p.width, 300);
});
