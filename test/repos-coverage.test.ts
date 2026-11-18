import { describe, expect, it, beforeEach } from "vitest";
import type { Config, Editions, StoreSnapshot } from "@riboseinc/cla-kernel";
import { createApp } from "../src/app";
import { repoRow, licenseFromResponse } from "../src/enforcement/report";
import type { RepoLicense } from "../src/enforcement/report";
import { makeFixture, makeKeyPem, CURRENT_EDITIONS, DATA_OCLA, type Fixture } from "./helpers";

/**
 * The repo-centric coverage report (issue #88): repos x people x state.
 * The kernel stays the only authority on coverage; the report adds the
 * operator's view — who contributes, and what each person's live state is.
 *
 * The state table is exercised against `repoRow` with plain snapshots:
 * the snapshot loader's HTTP/ETag caching is not what this file is about,
 * and depending on it would make these assertions order-sensitive.
 */

const EDITIONS: Editions = {
  icla: { kind: "icla", version: CURRENT_EDITIONS.icla.version, textSha256: CURRENT_EDITIONS.icla.sha256 },
  ocla: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: CURRENT_EDITIONS.ocla.sha256 },
};

const snap = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({ iclas: [], oclas: [], revokedIds: [], ...over });

/** What the report reads when Licensee says the repo has no license file. */
const NO_LICENSE: RepoLicense = { spdx: null, state: "none" };

const icla = (over: Partial<StoreSnapshot["iclas"][number]> = {}): StoreSnapshot["iclas"][number] => ({
  id: "icla-tj",
  githubLogin: "tj-91",
  email: "johannes@mtg.example",
  edition: EDITIONS.icla,
  ...over,
});

const ocla = (over: Partial<StoreSnapshot["oclas"][number]> = {}): StoreSnapshot["oclas"][number] => ({
  id: "ocla-mtg",
  orgSlug: "mtg-ag",
  covered: [{ githubLogin: "falko-strenzke", email: "falko@mtg.example" }],
  edition: EDITIONS.ocla,
  ...over,
});

const cfg = (allowlist: { global?: string[]; perOrg?: Record<string, string[]> } = {}): Config =>
  ({ coverage: { allowlist: { global: ["dependabot[bot]"], perOrg: {}, ...allowlist } } }) as Config;

const commit = (login: string | null, email: string, date = "2026-11-01T00:00:00Z", type = "User") => ({
  sha: `sha-${login ?? email}`,
  author: login ? { login, type } : null,
  commit: { author: { email, date } },
});

describe("repos-coverage: the person table", () => {
  it("maps kernel coverage to the roster's state words", () => {
    const row = repoRow(
      "org/repo",
      true,
      [
        commit("falko-strenzke", "falko@mtg.example"),
        commit("stranger", "s@x.example"),
        commit("dependabot[bot]", "bot@x.example", "2026-11-01T00:00:00Z", "Bot"),
        commit("estate-release-manager", "rm@x.example"),
      ],
      snap({ oclas: [ocla()] }),
      cfg({ perOrg: { org: ["estate-release-manager"] } }),
      EDITIONS,
      25,
      NO_LICENSE,
    );
    const by = (l: string) => row.contributors.find((c) => c.login === l);
    expect(by("falko-strenzke")).toMatchObject({ state: "signed", path: "ocla", edition: CURRENT_EDITIONS.ocla.version });
    expect(by("stranger")).toMatchObject({ state: "outstanding" });
    expect(by("dependabot[bot]")).toMatchObject({ state: "ci-account" });
    expect(by("estate-release-manager")).toMatchObject({ state: "allowlist" });
  });

  it("a signature on an older edition reads stale, not outstanding", () => {
    const stale = snap({ iclas: [icla({ edition: { kind: "icla", version: "0.9", textSha256: "older-sha" } })] });
    const row = repoRow("org/repo", true, [commit("tj-91", "johannes@mtg.example"), commit("stranger", "s@x.example")], stale, cfg(), EDITIONS, 25, NO_LICENSE);
    expect(row.contributors.find((c) => c.login === "tj-91")).toMatchObject({ state: "stale" });
    expect(row.contributors.find((c) => c.login === "stranger")).toMatchObject({ state: "outstanding" });
  });

  it("an OCLA row names which organization covers the person; an ICLA row names none", () => {
    const both = snap({
      iclas: [icla()],
      oclas: [
        ocla({ id: "ocla-mtg", orgSlug: "mtg-ag", covered: [{ githubLogin: "falko-strenzke", email: "falko@mtg.example" }] }),
        ocla({ id: "ocla-acme", orgSlug: "acme", covered: [{ githubLogin: "acme-dev", email: "dev@acme.example" }] }),
      ],
    });
    const row = repoRow(
      "org/repo",
      true,
      [commit("tj-91", "johannes@mtg.example"), commit("falko-strenzke", "falko@mtg.example"), commit("acme-dev", "dev@acme.example")],
      both,
      cfg(),
      EDITIONS,
      25,
      NO_LICENSE,
    );
    const by = (l: string) => row.contributors.find((c) => c.login === l);
    // "covered by an OCLA" is not enough for the operator: WHICH OCLA.
    expect(by("falko-strenzke")).toMatchObject({ state: "signed", path: "ocla", org_slug: "mtg-ag" });
    expect(by("acme-dev")).toMatchObject({ state: "signed", path: "ocla", org_slug: "acme" });
    expect(by("tj-91")).toMatchObject({ state: "signed", path: "icla" });
    expect(by("tj-91")?.org_slug).toBeUndefined();
  });

  it("two applicable agreements read must-specify with their options", () => {
    const both = snap({ iclas: [icla()], oclas: [ocla({ covered: [{ githubLogin: "tj-91", email: "johannes@mtg.example" }] })] });
    const row = repoRow("org/repo", true, [commit("tj-91", "johannes@mtg.example")], both, cfg(), EDITIONS, 25, NO_LICENSE);
    expect(row.contributors[0]?.state).toBe("must-specify");
    expect(row.contributors[0]?.options).toHaveLength(2);
  });

  it("a separate-agreement login is flagged while still reading signed", () => {
    const withRegistry = snap({ oclas: [ocla()], msaLogins: ["falko-strenzke"] });
    const row = repoRow("org/repo", true, [commit("falko-strenzke", "falko@mtg.example")], withRegistry, cfg(), EDITIONS, 25, NO_LICENSE);
    expect(row.contributors[0]).toMatchObject({ login: "falko-strenzke", state: "signed", under_separate_agreement: true });
  });

  it("an unlinked committer covered by email reads signed, unmatched reads outstanding", () => {
    const row = repoRow(
      "org/repo",
      true,
      [commit(null, "falko@mtg.example"), commit(null, "unlinked@example.org")],
      snap({ oclas: [ocla()] }),
      cfg(),
      EDITIONS,
      25,
      NO_LICENSE,
    );
    expect(row.contributors[0]).toMatchObject({ login: null, state: "signed", matched_by: "email" });
    expect(row.contributors[1]).toMatchObject({ login: null, state: "outstanding" });
  });
});

describe("repos-coverage: the license inventory (issue #116)", () => {
  it("a LICENSE reports its SPDX id; no license file is `none`, never an implied permissive default", () => {
    expect(licenseFromResponse(200, JSON.stringify({ license: { spdx_id: "BUSL-1.1" } }))).toEqual({ spdx: "BUSL-1.1", state: "declared" });
    expect(licenseFromResponse(404, JSON.stringify({ message: "Not Found" }))).toEqual({ spdx: null, state: "none" });
  });

  it("a lookup the App could not complete is `unreadable`, distinct from `none`", () => {
    expect(licenseFromResponse(500, "{}")).toMatchObject({ spdx: null, state: "unreadable" });
    expect(licenseFromResponse(500, "{}").note).toContain("500");
    expect(licenseFromResponse(200, "not json")).toMatchObject({ state: "unreadable" });
    expect(licenseFromResponse(200, JSON.stringify({ license: null }))).toMatchObject({ state: "unreadable" });
  });

  it("Licensee's NOASSERTION is kept verbatim: a license file exists that it cannot map", () => {
    expect(licenseFromResponse(200, JSON.stringify({ license: { spdx_id: "NOASSERTION" } }))).toEqual({ spdx: "NOASSERTION", state: "declared" });
  });

  it("an excluded repo still reports its license, with the excluded scope", () => {
    const row = repoRow("org/mirror", false, [], snap(), cfg(), EDITIONS, 25, { spdx: "BSD-3-Clause", state: "declared" });
    expect(row).toMatchObject({ in_scope: false, scope: "excluded", license: { spdx: "BSD-3-Clause" }, contributors: [] });
  });

  it("an in-scope repo names the standard scope binding", () => {
    const row = repoRow("org/repo", true, [commit("stranger", "s@x.example")], snap(), cfg(), EDITIONS, 25, { spdx: "BUSL-1.1", state: "declared" });
    expect(row).toMatchObject({ in_scope: true, scope: "standard", license: { spdx: "BUSL-1.1", state: "declared" } });
  });
});

describe("repos-coverage: route posture", () => {
  let pem: string;
  let fx: Fixture;

  beforeEach(async () => {
    pem = await makeKeyPem();
    fx = makeFixture();
  });

  const app = (env: Record<string, unknown> = {}) =>
    createApp({ OPS_TOKEN: "ops-tok", GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem, ...env }, { fetcher: fx.fetcher });

  const get = (query: string, auth: string | null = "ops-tok", env: Record<string, unknown> = {}) =>
    app(env).request(`/admin/repos-coverage${query}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  const listRepos = (repos: string[]) =>
    fx.routes.set("/installation/repositories", () =>
      Response.json({ total_count: repos.length, repositories: repos.map((full_name) => ({ full_name })) }, { status: 200 }),
    );

  it("fail-closed: no ops token -> the report does not exist; bad token -> 403; no installation -> 400", async () => {
    const naked = createApp({ GITHUB_APP_ID: "1", APP_PRIVATE_KEY: pem }, { fetcher: fx.fetcher });
    expect((await naked.request("/admin/repos-coverage?installation_id=42")).status).toBe(404);
    expect((await get("?installation_id=42", "wrong")).status).toBe(403);
    expect((await get("")).status).toBe(400);
  });

  it("an empty repository is reported with its reason, not as an empty table", async () => {
    listRepos(["org/empty"]);
    fx.routes.set("/repos/org/empty/commits", () => new Response("{}", { status: 409 }));

    const out = (await (await get("?installation_id=42")).json()) as any;
    expect(out.repos[0]).toMatchObject({ repo: "org/empty", in_scope: true, contributors: [] });
    expect(out.repos[0].note).toContain("empty repository");
    expect(out.notes.join(" ")).toContain("administration permission");
    // A store that loaded nothing reads as "everyone outstanding" — the
    // report must say what it loaded so that failure is never silent.
    expect(out.notes[0]).toBe("records loaded: 1 ICLA, 1 OCLA");
    // …and WHICH editions this deploy evaluated against: without that
    // line a stale bundle is indistinguishable from ordinary drift
    // (issue #104).
    expect(out.notes[1]).toContain(`icla v${CURRENT_EDITIONS.icla.version} sha ${CURRENT_EDITIONS.icla.sha256.slice(0, 8)}`);
    expect(out.notes[1]).toContain(`ocla v${CURRENT_EDITIONS.ocla.version} sha ${CURRENT_EDITIONS.ocla.sha256.slice(0, 8)}`);
  });

  it("every repo row carries the license inventory and its scope binding", async () => {
    listRepos(["conormis/platform", "org/unlicensed"]);
    fx.routes.set("/repos/conormis/platform/license", () => Response.json({ license: { spdx_id: "BUSL-1.1" } }, { status: 200 }));
    fx.routes.set("/repos/org/unlicensed/license", () => new Response("{}", { status: 404 }));
    fx.routes.set("/repos/conormis/platform/commits", () => Response.json([commit("tj-91", "johannes@mtg.example")], { status: 200 }));
    fx.routes.set("/repos/org/unlicensed/commits", () => Response.json([commit("stranger", "s@x.example")], { status: 200 }));

    const out = (await (await get("?installation_id=42")).json()) as any;
    expect(out.repos[0]).toMatchObject({
      repo: "conormis/platform",
      scope: "standard",
      license: { spdx: "BUSL-1.1", state: "declared" },
    });
    expect(out.repos[1]).toMatchObject({
      repo: "org/unlicensed",
      scope: "standard",
      license: { spdx: null, state: "none" },
    });
  });

  it("a stale bundle names itself: the stored edition hash disagrees with the compiled one (issue #104)", async () => {
    listRepos(["org/a"]);
    fx.routes.set("/repos/org/a/commits", () => Response.json([commit("tj-91", "johannes@mtg.example")], { status: 200 }));
    // Only the OCLA in the tree, signed against a DIFFERENT OCLA 1.0 text
    // than this deployment compiled: every record of that edition reads
    // not-live, so a covered person surfaces as stale.
    fx.routes.set("/repos/example-org/cla-data/git/trees/HEAD", () => Response.json({ tree: [{ path: "ocla/2026/03/mtg.json", type: "blob" }] }, { status: 200 }));
    fx.routes.set("/repos/example-org/cla-data/contents/ocla/2026/03/mtg.json", () =>
      Response.json(
        {
          content: Buffer.from(
            JSON.stringify({ ...DATA_OCLA(), claEdition: { kind: "ocla", version: CURRENT_EDITIONS.ocla.version, textSha256: "0".repeat(64) } }),
          ).toString("base64"),
          encoding: "base64",
        },
        { status: 200 },
      ),
    );

    const out = (await (await get("?installation_id=42")).json()) as any;
    const notes = (out.notes as string[]).join(" ");
    expect(notes).toContain("edition mismatch");
    expect(notes).toContain(`this deployment compiled sha ${CURRENT_EDITIONS.ocla.sha256.slice(0, 8)}`);
    expect(notes).toContain("not trustworthy");
    // The state word here is `stale` — "a record exists but is not live" —
    // which an operator would otherwise read as "they signed an old
    // edition". Only the note distinguishes a stale signature from a
    // stale deployment (issue #104).
    expect(out.repos[0].contributors[0]).toMatchObject({ login: "tj-91", state: "stale" });
  });

  it("a step covers `limit` repos and hands back the cursor", async () => {
    listRepos(["org/a", "org/b"]);
    fx.routes.set("/repos/org/a/commits", () => Response.json([commit("tj-91", "johannes@mtg.example")], { status: 200 }));
    fx.routes.set("/repos/org/b/commits", () => Response.json([commit("stranger", "s@x.example")], { status: 200 }));

    const first = (await (await get("?installation_id=42&limit=1")).json()) as any;
    expect(first.repos).toHaveLength(1);
    expect(first.repos[0].repo).toBe("org/a");
    expect(first.next).toEqual({ page: 1, offset: 1 });
    expect(fx.calls.filter((c) => c.url.includes("/repos/org/b/commits"))).toHaveLength(0);

    const second = (await (await get("?installation_id=42&limit=1&offset=1")).json()) as any;
    expect(second.repos[0].repo).toBe("org/b");
    expect(second.next).toBeNull();
  });
});
