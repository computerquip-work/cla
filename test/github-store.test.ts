import { describe, expect, it } from "vitest";
import type { Editions } from "@riboseinc/cla-kernel";
import { GithubApi } from "../src/github/api";
import { ETAG_CACHE, TOKEN_CACHE } from "../src/cache";
import { makeListRecords } from "../src/store/github-store";
import { loadSnapshot } from "../src/store/load";
import { makeKeyPem } from "./helpers";

/**
 * The store leg's transport failures (issue #104). A listing with holes
 * and a record read that did not happen BOTH read downstream as "this
 * person never signed" — the false coverage gap the issue chased. Neither
 * may become a snapshot; both must fail so the caller can fail honestly.
 */

const EDITIONS: Editions = {
  icla: { kind: "icla", version: "1.0", textSha256: "icla1sha" },
  ocla: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
};

const DATA_INSTALLATION = 9;

async function apiWith(respond: (url: URL) => Response | undefined): Promise<GithubApi> {
  const pem = await makeKeyPem();
  return new GithubApi({
    fetcher: async (url) => {
      const u = new URL(url);
      if (u.pathname === `/app/installations/${DATA_INSTALLATION}/access_tokens`) {
        return Response.json({ token: "ghs_9" }, { status: 201 });
      }
      return respond(u) ?? new Response("not found", { status: 404 });
    },
    now: () => 0,
    appId: "1",
    privateKeyPem: pem,
    tokenCache: TOKEN_CACHE,
    etagCache: ETAG_CACHE,
  });
}

const blob = (path: string) => ({ path, type: "blob" });
const base64 = (value: unknown) => ({
  content: Buffer.from(JSON.stringify(value)).toString("base64"),
  encoding: "base64",
});

describe("makeListRecords: an incomplete record set is never a snapshot", () => {
  it("a truncated tree listing is refused, not evaluated short", async () => {
    // GitHub caps a recursive listing and says so with `truncated`; the
    // records it dropped are absent without any error of their own.
    const api = await apiWith((u) =>
      u.pathname.endsWith("/git/trees/HEAD") ? Response.json({ tree: [blob("ocla/2026/03/o.json")], truncated: true }, { status: 200 }) : undefined,
    );
    const list = makeListRecords(api, DATA_INSTALLATION, "o/trunc");
    await expect(list()).rejects.toThrow(/truncated/);
  });

  it("a record read that failed fails the load — it never degrades into a rejected record", async () => {
    const api = await apiWith((u) => {
      if (u.pathname.endsWith("/git/trees/HEAD")) return Response.json({ tree: [blob("ocla/2026/03/o.json")] }, { status: 200 });
      if (u.pathname.endsWith("/contents/ocla/2026/03/o.json")) return new Response("upstream said no", { status: 502 });
      return undefined;
    });
    const list = makeListRecords(api, DATA_INSTALLATION, "o/blob");
    await expect(loadSnapshot({ listRecords: list }, EDITIONS)).rejects.toThrow(/ocla\/2026\/03\/o\.json \(502\)/);
  });

  it("an intact listing and its records still load", async () => {
    const api = await apiWith((u) => {
      if (u.pathname.endsWith("/git/trees/HEAD")) return Response.json({ tree: [blob("ocla/2026/03/o.json")] }, { status: 200 });
      if (u.pathname.endsWith("/contents/ocla/2026/03/o.json")) {
        return Response.json(
          base64({ id: "o1", orgSlug: "mtg-ag", claEdition: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" }, covered: [{ githubLogin: "tj-91" }] }),
          { status: 200 },
        );
      }
      return undefined;
    });
    const { snapshot, rejected, editionDivergences } = await loadSnapshot(
      { listRecords: makeListRecords(api, DATA_INSTALLATION, "o/ok") },
      EDITIONS,
    );
    expect(snapshot.oclas.map((o) => o.id)).toEqual(["o1"]);
    expect(rejected).toEqual([]);
    expect(editionDivergences).toEqual([]);
  });
});
