import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { makeFixture, makeKeyPem, signedBody, WEBHOOK_SECRET, type Fixture } from "./helpers";
import { CHECK_NAME } from "../src/enforcement/checks";

/**
 * Check pre-registration at installation scale: the webhook pre-registers
 * a bounded batch (a large org's install event must not blow the
 * invocation budget), and the ops backfill walks the installation with a
 * resumable cursor until every repo carries the neutral run.
 */

let pem: string;
let fx: Fixture;

beforeEach(async () => {
  pem = await makeKeyPem();
  fx = makeFixture();
});

const app = () =>
  createApp({ OPS_TOKEN: "ops-tok", GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem, WEBHOOK_SECRET }, { fetcher: fx.fetcher });

const post = (path: string, body: Record<string, unknown>, auth = true) =>
  app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer ops-tok" } : {}) },
    body: JSON.stringify(body),
  });

const checkRunsPosted = () => fx.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));

const seedRepo = (name: string) => {
  fx.routes.set(`/repos/${name}`, () => Response.json({ default_branch: "main" }, { status: 200 }));
  fx.routes.set(`/repos/${name}/commits/main`, () => Response.json({ sha: `sha-${name}` }, { status: 200 }));
};

const deliverInstallation = async (payload: Record<string, unknown>) => {
  const { body, headers } = await signedBody(WEBHOOK_SECRET, payload);
  return app().request("/api/github/webhook", {
    method: "POST",
    body,
    headers: { ...headers, "x-github-event": "installation" },
  });
};

describe("installation webhook: bounded pre-registration", () => {
  it("a 30-repo install registers the first batch and defers the rest", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `org/r${i}`);
    names.forEach(seedRepo);

    const res = await deliverInstallation({ action: "created", installation: { id: 42 }, repositories: names.map((full_name) => ({ full_name })) });

    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect((out["preregistered"] as string[]).length).toBe(25);
    expect(out["deferred"]).toBe(5);
    expect((out["failed"] as unknown[]).length).toBe(0);
    expect(checkRunsPosted().length).toBe(25);
  });

  it("one bad repo does not strand the batch: reported, not thrown", async () => {
    seedRepo("org/ok");
    fx.routes.set("/repos/org/broken", () => new Response("boom", { status: 500 }));

    const res = await deliverInstallation({
      action: "created",
      installation: { id: 42 },
      repositories: [{ full_name: "org/ok" }, { full_name: "org/broken" }],
    });

    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["preregistered"]).toEqual(["org/ok"]);
    expect(out["failed"]).toEqual([{ repo: "org/broken", reason: "repo info failed: 500" }]);
  });

  it("systemic failure stays an honest 503 (GitHub redelivers)", async () => {
    fx.routes.set("/repos/org/broken", () => new Response("boom", { status: 500 }));

    const res = await deliverInstallation({ action: "created", installation: { id: 42 }, repositories: [{ full_name: "org/broken" }] });

    expect(res.status).toBe(503);
    expect((await res.json()) as Record<string, unknown>).toHaveProperty("error");
  });

  it("idempotent: an existing cla/ribose run is not duplicated", async () => {
    seedRepo("org/r0");
    fx.routes.set("/repos/org/r0/commits/main/check-runs", () =>
      Response.json({ check_runs: [{ id: 1, name: CHECK_NAME }] }, { status: 200 }),
    );

    const res = await deliverInstallation({ action: "created", installation: { id: 42 }, repositories: [{ full_name: "org/r0" }] });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["preregistered"]).toEqual(["org/r0"]);
    expect(checkRunsPosted().length).toBe(0);
  });
});

describe("ops backfill: resumable over the whole installation", () => {
  const listRoute = (names: string[]) => {
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: names.length, repositories: names.map((full_name) => ({ full_name })) }, { status: 200 }),
    );
  };

  it("walks a chunk per call and finishes when the cursor is exhausted", async () => {
    const names = ["org/r0", "org/r1", "org/r2"];
    names.forEach(seedRepo);
    listRoute(names);

    const first = await post("/admin/preregister", { installation_id: 42, limit: 2 });
    expect(first.status).toBe(200);
    const out1 = (await first.json()) as Record<string, unknown>;
    expect(out1["done"]).toEqual(["org/r0", "org/r1"]);
    expect(out1["total"]).toBe(3);
    expect(out1["next"]).toEqual({ page: 1, offset: 2 });

    const second = await post("/admin/preregister", { installation_id: 42, limit: 2, cursor: out1["next"] });
    const out2 = (await second.json()) as Record<string, unknown>;
    expect(out2["done"]).toEqual(["org/r2"]);
    expect(out2["next"]).toBeNull();

    expect(checkRunsPosted().length).toBe(3);
    expect(fx.calls.some((c) => c.url.includes("/installation/repositories?per_page=100&page=1"))).toBe(true);
  });

  it("a failed repo is reported and the step continues", async () => {
    seedRepo("org/ok");
    fx.routes.set("/repos/org/broken", () => new Response("boom", { status: 500 }));
    listRoute(["org/ok", "org/broken"]);

    const res = await post("/admin/preregister", { installation_id: 42, limit: 10 });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["done"]).toEqual(["org/ok"]);
    expect((out["failed"] as unknown[]).length).toBe(1);
    expect(out["next"]).toBeNull();
  });

  it("fail-closed guards: no ops token -> absent, bad token -> 403, no installation -> 400", async () => {
    const naked = createApp({ GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    const none = await naked.request("/admin/preregister", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installation_id: 42 }),
    });
    expect(none.status).toBe(404);

    expect((await post("/admin/preregister", { installation_id: 42 }, false)).status).toBe(403);
    expect((await post("/admin/preregister", {})).status).toBe(400);
  });
});
