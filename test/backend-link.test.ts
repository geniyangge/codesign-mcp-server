import assert from "node:assert/strict";
import { test } from "node:test";

import { CoDesignClient } from "../src/client.js";

const DESIGN = 100000000000001;

/** 构造后台设计稿接口的响应 */
function designPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: DESIGN,
    name: "示例设计稿",
    viewport: "mobile",
    team: { name: "示例团队" },
    is_member: true,
    permission_type: "inherit",
    sharings: [{ id: 999, permissions: { commentable: true, inspectable: true, assetsDownloadable: false } }],
    sections: [
      {
        id: 1,
        screens: [
          { id: 1001, name: "首页" },
          { id: 1002, name: "详情" },
        ],
      },
    ],
    ...overrides,
  };
}

function stubFetch(payload: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

test("getShareByDesignId：用后台链接直接读取设计稿，不依赖分享 ID", async (t) => {
  let seenUrl = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    seenUrl = url;
    return new Response(JSON.stringify(designPayload()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const client = new CoDesignClient("access_token=t");
  const share = await client.getShareByDesignId(DESIGN);

  // 请求的是后台设计稿接口
  assert.match(seenUrl, new RegExp(`/api/designs/${DESIGN}`));
  assert.doesNotMatch(seenUrl, /sharings/);

  assert.equal(share.title, "示例设计稿");
  assert.equal(share.teamName, "示例团队");
  // share id 在设计稿链接场景下就是设计稿 ID
  assert.equal(share.id, DESIGN);
  assert.equal(share.designs[0].id, DESIGN);
  assert.deepEqual(share.designs[0].screens, [
    { id: 1001, name: "首页" },
    { id: 1002, name: "详情" },
  ]);
});

test("getShareByDesignId：没有 Cookie 时给出明确提示", async () => {
  const client = new CoDesignClient("");
  await assert.rejects(
    () => client.getShareByDesignId(DESIGN),
    (e: any) => e.name === "CoDesignError" && /CODESIGN_COOKIE/.test(e.hint ?? ""),
  );
});

test("getShareByDesignId：设计稿没有画板时报错并说明原因", async (t) => {
  t.mock.method(globalThis, "fetch", stubFetch(designPayload({ sections: [] })));

  const client = new CoDesignClient("access_token=t");
  await assert.rejects(
    () => client.getShareByDesignId(DESIGN),
    (e: any) => /没有找到任何画板/.test(e.message),
  );
});

test("getShareByDesignId：sections 为空时回退到顶层 screens", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    stubFetch(designPayload({ sections: [], screens: [{ id: 2001, name: "兜底画板" }] })),
  );

  const client = new CoDesignClient("access_token=t");
  const share = await client.getShareByDesignId(DESIGN);
  assert.deepEqual(share.designs[0].screens, [{ id: 2001, name: "兜底画板" }]);
});
