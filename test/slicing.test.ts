import assert from "node:assert/strict";
import { test } from "node:test";

import { imageOps, pickExport, planSlices, sliceFileName } from "../src/slicing.js";
import { createNamer } from "../src/utils/filename.js";
import type { Layer, SliceItem } from "../src/types.js";

/** 造一条切图项，默认单个 3x 导出（线上真实形态） */
function slice(over: Partial<SliceItem> = {}, exportsOverride?: any[]): SliceItem {
  return {
    id: "49",
    name: "图标",
    rect: { x: 110, y: 289, width: 104, height: 41 },
    exports: exportsOverride ?? [
      {
        name: "图标",
        scale: 3,
        format: "png",
        width: 312,
        height: 123,
        downloadUrl: "https://cdn4.codesign.qq.com/a.png?imageMogr2/format/png",
        objectId: "49",
      },
    ],
    ...over,
  };
}

function layer(over: Partial<Layer> = {}): Layer {
  return {
    id: "49",
    objectId: "49",
    name: "图标",
    type: "group",
    rect: { x: 110, y: 289, width: 104, height: 41 },
    visible: true,
    z: 7,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 操作链组装
// ---------------------------------------------------------------------------

test("imageOps 组装 cut + thumbnail + format + quality", () => {
  const ops = imageOps({
    crop: { x: 10, y: 20, width: 100, height: 50 },
    targetWidth: 200,
    format: "webp",
    quality: 80,
  });
  assert.deepEqual(ops, ["cut/100x50x10x20", "thumbnail/200x", "format/webp", "quality/80"]);
});

test("imageOps 裁剪坐标取整且不为负", () => {
  const ops = imageOps({ crop: { x: -5, y: 3.4, width: 99.6, height: 50.2 } });
  assert.deepEqual(ops, ["cut/100x50x0x3"]);
});

test("imageOps quality 只对 jpg/webp 生效并钳制在 1-100", () => {
  assert.deepEqual(imageOps({ format: "png", quality: 50 }), ["format/png"]);
  assert.deepEqual(imageOps({ format: "jpg", quality: 0 }), ["format/jpg", "quality/1"]);
  assert.deepEqual(imageOps({ format: "jpg", quality: 300 }), ["format/jpg", "quality/100"]);
});

// ---------------------------------------------------------------------------
// 倍率选择
// ---------------------------------------------------------------------------

test("pickExport 优先精确倍率", () => {
  const item = slice({}, [
    { name: "a", scale: 1, format: "png", width: 104, height: 41, downloadUrl: "u1", objectId: "49" },
    { name: "a", scale: 2, format: "png", width: 208, height: 82, downloadUrl: "u2", objectId: "49" },
  ]);
  const picked = pickExport(item, 2);
  assert.equal(picked?.export.downloadUrl, "u2");
  assert.equal(picked?.substituted, false);
});

test("pickExport 缺目标倍率时就近取不超过目标的最高档", () => {
  const item = slice({}, [
    { name: "a", scale: 1, format: "png", width: 104, height: 41, downloadUrl: "u1", objectId: "49" },
    { name: "a", scale: 3, format: "png", width: 312, height: 123, downloadUrl: "u3", objectId: "49" },
  ]);
  const picked = pickExport(item, 2);
  assert.equal(picked?.export.downloadUrl, "u1");
  assert.equal(picked?.substituted, true);
});

// ---------------------------------------------------------------------------
// 命名
// ---------------------------------------------------------------------------

test("sliceFileName 带倍率后缀", () => {
  assert.equal(sliceFileName("图标", 2), "图标@2x");
  assert.equal(sliceFileName("图层 5", 3), "图层 5@3x");
  assert.equal(sliceFileName("图标", 1.5), "图标@1.5x");
  assert.equal(sliceFileName("", 2), "slice@2x");
});

// ---------------------------------------------------------------------------
// 端到端规划
// ---------------------------------------------------------------------------

test("planSlices 只有 3x 导出时会重采样到目标倍率尺寸", () => {
  // 线上真实情况：设计稿只有 3x，请求 2 倍图
  const entries = planSlices([slice()], [layer()], { scale: 2, namer: createNamer() });
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.exportScale, 3);
  assert.equal(e.targetScale, 2);
  assert.equal(e.resampled, true);
  assert.equal(e.substituted, true);
  // 104 * 2 = 208，而不是 3x 的 312
  assert.equal(e.width, 208);
  // 等比：123 / 312 * 208 = 82
  assert.equal(e.height, 82);
  assert.match(e.downloadUrl, /thumbnail\/208x/);
  assert.equal(e.file, "图标@2x.png");
  assert.equal(e.ref, "s1");
});

test("planSlices 精确倍率时不重采样、不加 thumbnail", () => {
  const twoX = slice({}, [
    { name: "图标", scale: 2, format: "png", width: 208, height: 82, downloadUrl: "https://cdn4.codesign.qq.com/a.png?imageMogr2/format/png", objectId: "49" },
  ]);
  const e = planSlices([twoX], [layer()], { scale: 2, namer: createNamer() })[0];
  assert.equal(e.resampled, false);
  assert.equal(e.substituted, false);
  assert.equal(e.width, 208);
  assert.ok(!/thumbnail/.test(e.downloadUrl), "不应出现 thumbnail: " + e.downloadUrl);
});

test("planSlices 指定 format 时替换掉已有 format 而不是重复追加", () => {
  // 实测坑：format/png/format/webp 只认第一个，返回的仍是 PNG
  const e = planSlices([slice()], [layer()], { scale: 2, format: "webp", namer: createNamer() })[0];
  assert.equal((e.downloadUrl.match(/format\//g) || []).length, 1, "只能有一个 format: " + e.downloadUrl);
  assert.match(e.downloadUrl, /format\/webp/);
  assert.ok(!/format\/png/.test(e.downloadUrl), "旧的 format/png 必须被替换: " + e.downloadUrl);
  assert.equal(e.file, "图标@2x.webp");
});

test("planSlices svg 不做任何 imageMogr2 处理", () => {
  const svg = slice({}, [
    { name: "图标", scale: 2, format: "svg", width: 104, height: 41, downloadUrl: "https://cdn4.codesign.qq.com/a.svg", objectId: "49" },
  ]);
  const e = planSlices([svg], [layer()], { scale: 2, namer: createNamer() })[0];
  assert.ok(!/imageMogr2|thumbnail/.test(e.downloadUrl), "svg 不应带操作链: " + e.downloadUrl);
});

test("planSlices 用切图项 rect 而非组图层 rect 计算目标尺寸", () => {
  // 组图层报整屏 750×1612，切图项才是真实的 388×180
  const badGroup = layer({ rect: { x: 0, y: 0, width: 750, height: 1612 } });
  const item = slice({ rect: { x: 0, y: 0, width: 388, height: 180 } }, [
    { name: "g", scale: 3, format: "png", width: 1164, height: 540, downloadUrl: "https://cdn4.codesign.qq.com/g.png?imageMogr2/format/png", objectId: "49" },
  ]);
  const e = planSlices([item], [badGroup], { scale: 2, namer: createNamer() })[0];
  assert.equal(e.width, 776, "388 × 2");
  assert.deepEqual(e.rect, { x: 0, y: 0, width: 388, height: 180 });
});

test("planSlices 同名切图由命名器去重且与 manifest 一致", () => {
  const a = slice({ id: "1", name: "图标", exports: [{ name: "图标", scale: 2, format: "png", width: 208, height: 82, downloadUrl: "https://cdn4.codesign.qq.com/a.png?imageMogr2/format/png", objectId: "1" }] });
  const b = slice({ id: "2", name: "图标", exports: [{ name: "图标", scale: 2, format: "png", width: 208, height: 82, downloadUrl: "https://cdn4.codesign.qq.com/b.png?imageMogr2/format/png", objectId: "2" }] });
  const entries = planSlices([a, b], [], { scale: 2, namer: createNamer() });
  assert.deepEqual(
    entries.map((e) => e.file),
    ["图标@2x.png", "图标@2x_2.png"],
  );
  assert.deepEqual(
    entries.map((e) => e.ref),
    ["s1", "s2"],
  );
});

test("planSlices 保留图层 z 值供层叠排序", () => {
  const e = planSlices([slice()], [layer({ z: 42 })], { scale: 2, namer: createNamer() })[0];
  assert.equal(e.z, 42);
});

test("planSlices targetWidth 优先于 scale", () => {
  const e = planSlices([slice()], [layer()], { scale: 3, targetWidth: 150, namer: createNamer() })[0];
  assert.equal(e.width, 150);
  assert.match(e.downloadUrl, /thumbnail\/150x/);
});
