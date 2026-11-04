import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize, toCsv, toManifestEntries } from "../src/manifest.js";
import type { DownloadResult } from "../src/types.js";

function result(over: Partial<DownloadResult> = {}): DownloadResult {
  return {
    name: "图标",
    path: "图标@2x.png",
    ref: "s1",
    objectId: "49",
    rect: { x: 110, y: 289, width: 104, height: 41 },
    z: 7,
    format: "png",
    tier: "slice",
    exportScale: 3,
    targetScale: 2,
    resampled: true,
    width: 208,
    height: 82,
    bytes: 1234,
    ok: true,
    ...over,
  };
}

test("toManifestEntries 以 ref/objectId 为主键并带上坐标", () => {
  const [e] = toManifestEntries([result()], { id: 100, name: "h5" });
  assert.equal(e.ref, "s1");
  assert.equal(e.objectId, "49");
  assert.equal(e.layerName, "图标");
  assert.equal(e.screenId, 100);
  assert.equal(e.screenName, "h5");
  assert.deepEqual({ x: e.x, y: e.y, width: e.width, height: e.height }, { x: 110, y: 289, width: 104, height: 41 });
  assert.equal(e.z, 7);
  assert.equal(e.exportScale, 3);
  assert.equal(e.targetScale, 2);
  assert.equal(e.resampled, true);
  assert.equal(e.actualWidth, 208);
  assert.equal(e.ok, true);
});

test("toManifestEntries 保留失败原因", () => {
  const [e] = toManifestEntries([result({ ok: false, bytes: 0, error: "网络超时" })]);
  assert.equal(e.ok, false);
  assert.equal(e.error, "网络超时");
});

test("toCsv 处理含逗号与引号的中文图层名", () => {
  const entries = toManifestEntries([
    result({ name: '图片"A", 拷贝' }),
    result({ name: "普通名字", path: "b@2x.png", ref: "s2" }),
  ]);
  const lines = toCsv(entries).split("\r\n");
  assert.match(lines[0], /^ref,objectId,layerName,/);
  // 含逗号和引号 -> 整格加引号，内部引号翻倍
  assert.match(lines[1], /"图片""A"", 拷贝"/);
  assert.match(lines[2], /普通名字/);
});

test("toCsv 表头列顺序固定", () => {
  const header = toCsv([]).split("\r\n")[0];
  assert.equal(
    header,
    "ref,objectId,layerName,screenId,screenName,tier,file,x,y,width,height,z,format,exportScale,targetScale,resampled,actualWidth,actualHeight,bytes,ok,error",
  );
});

test("summarize 汇总层级、失败、重采样与体积", () => {
  const entries = toManifestEntries([
    result(),
    result({ path: "b.png", ref: "s2", tier: "composite", resampled: false, bytes: 500 }),
    result({ path: "c.png", ref: "s3", ok: false, bytes: 0, resampled: false }),
  ]);
  const s = summarize(entries);
  assert.equal(s.total, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.resampled, 1);
  assert.equal(s.bytes, 1734);
  assert.deepEqual(s.byTier, { slice: 2, composite: 1 });
});
