import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import worker from "../worker.js";

const dist = pathToFileURL(`${resolve(process.env.TUYUWEB_DIST || new URL("../dist", import.meta.url).pathname)}/`);

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("falls back to the root document for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/" ? "app" : "missing", {
            status: url.pathname === "/" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/"]);
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
    assert.equal(response.headers.get("permissions-policy"), "camera=(), geolocation=(), microphone=()");
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("client/index.html", dist));
  await access(new URL("client/_headers", dist));
  await access(new URL("server/index.js", dist));
  await access(new URL(".openai/hosting.json", dist));
});

test("serves the embedded homepage from the production worker", async () => {
  const builtWorker = (await import(new URL("server/index.js", dist))).default;
  let assetCalls = 0;
  const response = await builtWorker.fetch(
    new Request("https://example.test/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async () => {
          assetCalls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    },
  );

  assert.equal(assetCalls, 1);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(await response.text(), /途遇 TuyuLove｜从这里，遇见下一段旅程/);
});

test("applies security headers at the static asset layer", async () => {
  const headers = await readFile(new URL("client/_headers", dist), "utf8");

  assert.match(headers, /^\/\*/m);
  assert.match(headers, /Content-Security-Policy: default-src 'self'/);
  assert.match(headers, /Permissions-Policy: camera=\(\), geolocation=\(\), microphone=\(\)/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /X-Frame-Options: DENY/);
});
