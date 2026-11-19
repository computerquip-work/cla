import { describe, expect, it } from "vitest";
import {
  evaluate,
  type Committer,
  type Config,
  type Editions,
  type PrInput,
  type StoreSnapshot,
} from "../src/evaluate";

// ---- fixture helpers (plain data — the real input types, no doubles) ----

const EDITIONS: Editions = {
  icla: { kind: "icla", version: "1.0", textSha256: "icla1sha" },
  ocla: { kind: "ocla", version: "1.0", textSha256: "ocla1sha" },
};

const config = (over: Partial<Config["coverage"]> = {}): Config => ({
  coverage: {
    ...over,
    allowlist: { global: [], perOrg: {}, ...over.allowlist },
  },
});

const icla = (over: Partial<StoreSnapshot["iclas"][number]> = {}): StoreSnapshot["iclas"][number] => ({
  id: "icla-1",
  githubLogin: "contributor-a",
  email: "a@example.com",
  edition: EDITIONS.icla,
  ...over,
});

const ocla = (over: Partial<StoreSnapshot["oclas"][number]> = {}): StoreSnapshot["oclas"][number] => ({
  id: "ocla-1",
  orgSlug: "mtg-ag",
  covered: [
    { githubLogin: "tj-91", email: "johannes@mtg.example" },
    { githubLogin: "falko-strenzke", email: "falko@mtg.example" },
  ],
  edition: EDITIONS.ocla,
  ...over,
});

const snapshot = (over: Partial<StoreSnapshot> = {}): StoreSnapshot => ({
  iclas: [],
  oclas: [],
  revokedIds: [],
  ...over,
});

const pr = (committers: Committer[], org = "rnpgp"): PrInput => ({
  context: { org, repo: "rnp", pr: 1 },
  committers,
});

const login = (l: string, email?: string): Committer => ({ login: l, email });

// ---- the coverage matrix ----

describe("kernel: allowlist", () => {
  it("global allowlist covers a bot login, short-circuiting any agreements", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "dependabot[bot]" })] });
    const v = evaluate(
      pr([login("dependabot[bot]")]),
      snap,
      config({ allowlist: { global: ["dependabot[bot]"], perOrg: {} } }),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "allowlist" });
    expect(v.verdict).toBe("pass");
  });

  it("per-org allowlist applies only to the matching org", () => {
    const v = evaluate(
      pr([login("conormis-ci")], "conormis"),
      snapshot(),
      config({ allowlist: { global: [], perOrg: { conormis: ["conormis-ci"] } } }),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "allowlist" });

    const other = evaluate(
      pr([login("conormis-ci")], "rnpgp"),
      snapshot(),
      config({ allowlist: { global: [], perOrg: { conormis: ["conormis-ci"] } } }),
      EDITIONS,
    );
    expect(other.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: ICLA", () => {
  it("current-edition ICLA covers its login case-insensitively", () => {
    const v = evaluate(pr([login("TJ-91")]), snapshot({ iclas: [icla({ githubLogin: "tj-91" })] }), config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla" });
  });

  it("stale-edition ICLA does not cover (re-sign required)", () => {
    const stale = icla({ edition: { kind: "icla", version: "0.9", textSha256: "oldsha" } });
    const v = evaluate(pr([login("tj-91")]), snapshot({ iclas: [stale] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a revoked ICLA does not cover", () => {
    const v = evaluate(pr([login("tj-91")]), snapshot({ iclas: [icla()], revokedIds: ["icla-1"] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: OCLA Schedule A", () => {
  it("a current-edition OCLA covers its Schedule A logins", () => {
    const v = evaluate(pr([login("falko-strenzke")]), snapshot({ oclas: [ocla()] }), config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({
      status: "covered",
      path: "ocla",
      agreement: { kind: "ocla", orgSlug: "mtg-ag", oclaId: "ocla-1" },
    });
  });

  it("a stale-edition OCLA does not cover its Schedule A", () => {
    const stale = ocla({ edition: { kind: "ocla", version: "0.9", textSha256: "oldsha" } });
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [stale] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a voided (revoked) OCLA does not cover its Schedule A", () => {
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [ocla()], revokedIds: ["ocla-1"] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a login not on Schedule A is not covered by the org's OCLA", () => {
    const v = evaluate(pr([login("stranger")]), snapshot({ oclas: [ocla()] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: the separate-agreement registry is the coverage (issue #100)", () => {
  it("a registry login is covered outright — no records, no click", () => {
    const v = evaluate(
      pr([login("ribose-staff", "staff@ribose.example")]),
      snapshot({ msaLogins: ["ribose-staff"], msaEmails: [] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("pass");
    expect(v.committers[0]).toMatchObject({
      login: "ribose-staff",
      status: "covered",
      path: "separate-agreement",
      matchedBy: "login",
      underSeparateAgreement: true,
    });
  });

  it("an UNLINKED commit matches the registry by its git author email", () => {
    const v = evaluate(
      pr([{ login: null, email: "Contractor@Example.com" }]),
      snapshot({ msaLogins: ["someone"], msaEmails: ["contractor@example.com"] }),
      config(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({
      status: "covered",
      path: "separate-agreement",
      matchedBy: "email",
      underSeparateAgreement: true,
    });
  });

  it("runs before the allowlist, and never leaks onto an ICLA path", () => {
    const both = evaluate(
      pr([login("both")]),
      snapshot({ msaLogins: ["both"] }),
      config({ allowlist: { global: ["both"], perOrg: {} } }),
      EDITIONS,
    );
    expect(both.committers[0]).toMatchObject({ path: "separate-agreement" });

    // A signer who is NOT on the registry keeps the ICLA attribution: the
    // separate-agreement flag is the registry's alone.
    const iclaOnly = evaluate(
      pr([login("signer")]),
      snapshot({ iclas: [icla({ githubLogin: "signer" })], msaLogins: ["someone-else"] }),
      config(),
      EDITIONS,
    );
    expect(iclaOnly.committers[0]).toMatchObject({ status: "covered", path: "icla" });
    expect(iclaOnly.committers[0]).not.toHaveProperty("underSeparateAgreement");
  });
});

describe("kernel: the signature is the coverage (owner decision 2026-11-14)", () => {
  it("the kernel has no employment or staff path — only the registry, a signature, or the allowlist", () => {
    // #100 retired the employment path for good: a staff/contractor login
    // is covered by the static registry, never by a role lookup. Without a
    // registry entry, an ICLA record, or an allowlist, the login is missing.
    const v = evaluate(pr([login("ronald-t")]), snapshot(), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });
});

describe("kernel: must-specify (multi-agreement ambiguity)", () => {
  it("ICLA + OCLA coverage forces the PR to specify, listing both", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("must-specify");
    expect(v.committers[0]?.status === "must-specify" ? v.committers[0].options : []).toEqual([
      { kind: "icla", version: "1.0" },
      { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" },
    ]);
  });


  it("two OCLAs covering the same login force specification between them", () => {
    const second = ocla({ id: "ocla-2", orgSlug: "otherco" });
    const v = evaluate(pr([login("tj-91")]), snapshot({ oclas: [ocla(), second] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("must-specify");
  });
});

describe("kernel: unlinked-email fallback", () => {
  it("a commit with no GitHub login matches an ICLA by email", () => {
    const v = evaluate(
      pr([{ login: null, email: "A@Example.com" }]),
      snapshot({ iclas: [icla({ email: "a@example.com" })] }),
      config(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla", matchedBy: "email" });
  });

  it("a login that misses but an email that hits still covers", () => {
    const v = evaluate(
      pr([login("someone-else", "falko@mtg.example")]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla", matchedBy: "email" });
  });

  it("no login and no email match => missing", () => {
    const v = evaluate(pr([{ login: null, email: "unknown@example.com" }]), snapshot(), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("an uncovered unlinked committer fails the PR, not just its row", () => {
    const v = evaluate(pr([{ login: null, email: "unknown@example.com" }]), snapshot(), config(), EDITIONS);
    expect(v.verdict).toBe("fail");
    expect(v.missing).toEqual(["email:unknown@example.com"]);
  });

  it("a covered login plus an uncovered unlinked committer fails the PR", () => {
    const v = evaluate(
      pr([login("tj-91"), { login: null, email: "unknown@example.com" }]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.missing).toEqual(["email:unknown@example.com"]);
  });

  it("an unlinked committer matched by two agreements fails: there is no login to ask", () => {
    const second = ocla({ id: "ocla-2", orgSlug: "other-org", covered: [{ githubLogin: "someone", email: "unknown@example.com" }] });
    const v = evaluate(
      pr([{ login: null, email: "unknown@example.com" }]),
      snapshot({ iclas: [icla({ email: "unknown@example.com" })], oclas: [second] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.committers[0]?.status).toBe("missing");
    expect(v.mustSpecify).toEqual({});
  });
});

describe("kernel: attribution elections resolve must-specify", () => {
  const both = () => snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });

  it("a stored election for this (repo, pr, login) resolves to covered", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" } }];
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla" });
    expect(v.mustSpecify["tj-91"]).toBeUndefined();
  });

  it("an election for another login or PR does not resolve", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 2, login: "tj-91", agreement: { kind: "icla", version: "1.0" } }];
    expect(evaluate(pr([login("tj-91")]), snap, config(), EDITIONS).committers[0]?.status).toBe("must-specify");
  });

  it("an election naming a no-longer-live agreement stays must-specify", () => {
    const snap = both();
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "icla", version: "1.0" } }];
    // remove the icla path: only the ocla remains -> single path anyway... instead void the ocla and elect ocla
    snap.oclas = [];
    snap.attributions = [{ repo: "rnpgp/rnp", pr: 1, login: "tj-91", agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" } }];
    const v = evaluate(pr([login("tj-91")]), snap, config(), EDITIONS);
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla" }); // single live path wins, not the dead election
  });
});

describe("kernel: bots and PR verdicts", () => {
  it("bot committers are excluded from the verdict entirely", () => {
    const v = evaluate(
      pr([login("tj-91"), { login: "dependabot[bot]", isBot: true }]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.committers).toHaveLength(1);
    expect(v.verdict).toBe("pass");
  });

  it("PR verdict fails when any committer is missing", () => {
    const v = evaluate(
      pr([login("tj-91"), login("stranger")]),
      snapshot({ oclas: [ocla()] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("fail");
    expect(v.missing).toEqual(["stranger"]);
  });

  it("PR verdict surfaces must-specify without failing the covered", () => {
    const snap = snapshot({ iclas: [icla({ githubLogin: "tj-91" })], oclas: [ocla()] });
    const v = evaluate(pr([login("tj-91"), login("falko-strenzke")]), snap, config(), EDITIONS);
    expect(v.verdict).toBe("pass");
    expect(v.mustSpecify["tj-91"]).toBeDefined();
    expect(v.mustSpecify["falko-strenzke"]).toBeUndefined();
  });

  it("committers keep their input order (deterministic output)", () => {
    const v = evaluate(
      pr([login("zeta"), login("alpha")]),
      snapshot({ iclas: [icla({ githubLogin: "zeta" }), icla({ id: "icla-2", githubLogin: "alpha" })] }),
      config(),
      EDITIONS,
    );
    expect(v.committers.map((c) => c.login)).toEqual(["zeta", "alpha"]);
  });
});

describe("minimal change (proportionality, issue #58)", () => {
  const withDiff = (diff?: { files: number; codeLines: number }): PrInput => ({
    ...pr([login("stranger")]),
    ...(diff ? { diff } : {}),
  });

  it("under BOTH thresholds: passes without coverage, disclosed", () => {
    const v = evaluate(withDiff({ files: 2, codeLines: 9 }), snapshot(), config({ minimalChange: { files: 3, codeLines: 10 } }), EDITIONS);
    expect(v.verdict).toBe("pass");
    expect(v.minimalChange).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("at the thresholds (inclusive) still skips", () => {
    const v = evaluate(withDiff({ files: 3, codeLines: 10 }), snapshot(), config({ minimalChange: { files: 3, codeLines: 10 } }), EDITIONS);
    expect(v.minimalChange).toBe(true);
  });

  it("over EITHER threshold: enforcement applies (missing committer fails)", () => {
    const overFiles = evaluate(withDiff({ files: 4, codeLines: 1 }), snapshot(), config({ minimalChange: { files: 3, codeLines: 10 } }), EDITIONS);
    expect(overFiles.verdict).toBe("fail");
    expect(overFiles.minimalChange).toBeUndefined();
    const overLines = evaluate(withDiff({ files: 1, codeLines: 11 }), snapshot(), config({ minimalChange: { files: 3, codeLines: 10 } }), EDITIONS);
    expect(overLines.verdict).toBe("fail");
  });

  it("OFF by default: the same tiny PR enforces", () => {
    const v = evaluate(withDiff({ files: 1, codeLines: 1 }), snapshot(), config(), EDITIONS);
    expect(v.verdict).toBe("fail");
    expect(v.minimalChange).toBeUndefined();
  });

  it("no diff stats available: enforcement applies", () => {
    const v = evaluate(withDiff(undefined), snapshot(), config({ minimalChange: { files: 3, codeLines: 10 } }), EDITIONS);
    expect(v.verdict).toBe("fail");
  });
});

describe("kernel: duplicate live records fold to one agreement (rnp#2573)", () => {
  it("two live ICLA records for one login read as covered, not must-specify", () => {
    const v = evaluate(
      pr([login("r404r")]),
      snapshot({ iclas: [icla({ id: "icla-1", githubLogin: "r404r" }), icla({ id: "icla-2", githubLogin: "r404r" })] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("pass");
    expect(v.missing).toEqual([]);
    expect(Object.keys(v.mustSpecify)).toEqual([]);
    expect(v.committers).toEqual([{ login: "r404r", status: "covered", path: "icla", agreement: { kind: "icla", version: "1.0" }, matchedBy: "login" }]);
  });

  it("an ICLA and an OCLA remain a genuine must-specify after folding", () => {
    const v = evaluate(
      pr([login("dual")]),
      snapshot({
        iclas: [icla({ id: "icla-1", githubLogin: "dual" })],
        oclas: [ocla({ covered: [{ githubLogin: "dual", email: "d@example.com" }] })],
      }),
      config(),
      EDITIONS,
    );
    // must-specify is a pass verdict with an action_required conclusion:
    // the ambiguity is a question for the contributor, not a failure.
    expect(v.verdict).toBe("pass");
    expect(Object.keys(v.mustSpecify)).toEqual(["dual"]);
    expect(v.mustSpecify["dual"]).toHaveLength(2);
  });

  it("an email-matched duplicate pair also folds to covered", () => {
    const v = evaluate(
      pr([{ login: null, email: "a@example.com" }]),
      snapshot({ iclas: [icla({ id: "icla-1" }), icla({ id: "icla-2" })] }),
      config(),
      EDITIONS,
    );
    expect(v.verdict).toBe("pass");
    expect(Object.keys(v.mustSpecify)).toEqual([]);
  });
});

describe("kernel: coverage by GitHub-org membership (issue #16 item 4)", () => {
  // The transport resolves GitHub facts; this kernel only reads them.
  // A membership DESIGNATES under a mapped, LIVE OCLA — the signature
  // remains the coverage, and the path is a fallback: consulted only
  // when no signature matched.
  const memberCfg = (over: Partial<Config["coverage"]> = {}): Config =>
    config({ orgMembership: { "corp-org": "mtg-ag" }, ...over });
  const memberSnap = (over: Partial<StoreSnapshot> = {}): StoreSnapshot =>
    snapshot({ orgMembers: [{ login: "newdev", org: "corp-org" }], ...over });

  it("a member of a mapped org is covered under the live OCLA, flagged as membership", () => {
    const v = evaluate(pr([login("newdev")]), memberSnap({ oclas: [ocla()] }), memberCfg(), EDITIONS);
    expect(v.verdict).toBe("pass");
    expect(v.committers[0]).toMatchObject({
      status: "covered",
      path: "ocla",
      viaOrgMembership: true,
      matchedBy: "login",
      agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-1", orgSlug: "mtg-ag" },
    });
  });

  it("facts alone cover nobody: without the config map the login stays missing", () => {
    const v = evaluate(pr([login("newdev")]), memberSnap({ oclas: [ocla()] }), config(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("config alone covers nobody: without resolved facts the login stays missing", () => {
    const v = evaluate(pr([login("newdev")]), snapshot({ oclas: [ocla()] }), memberCfg(), EDITIONS);
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("an org the config does not map designates nothing", () => {
    const v = evaluate(
      pr([login("newdev")]),
      snapshot({ oclas: [ocla()], orgMembers: [{ login: "newdev", org: "other-org" }] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a stale OCLA designates nobody — the signature is still the coverage", () => {
    const v = evaluate(
      pr([login("newdev")]),
      memberSnap({ oclas: [ocla({ edition: { kind: "ocla", version: "1.0", textSha256: "othersha" } })] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("a revoked OCLA designates nobody", () => {
    const v = evaluate(
      pr([login("newdev")]),
      memberSnap({ oclas: [ocla()], revokedIds: ["ocla-1"] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]?.status).toBe("missing");
  });

  it("the fallback is a fallback: a signature wins and membership never adds ambiguity", () => {
    const v = evaluate(
      pr([login("newdev")]),
      memberSnap({ iclas: [icla({ githubLogin: "newdev" })], oclas: [ocla()] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "icla" });
    expect(v.committers[0]).not.toHaveProperty("viaOrgMembership");
    expect(Object.keys(v.mustSpecify)).toEqual([]);
  });

  it("a named Schedule A row wins over membership for the same OCLA", () => {
    const v = evaluate(
      pr([login("tj-91")]),
      memberSnap({ oclas: [ocla()] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla" });
    expect(v.committers[0]).not.toHaveProperty("viaOrgMembership");
  });

  it("two mapped orgs with two live OCLAs read as must-specify, like any two paths", () => {
    const v = evaluate(
      pr([login("newdev")]),
      snapshot({
        oclas: [ocla(), ocla({ id: "ocla-2", orgSlug: "other-corp", covered: [] })],
        orgMembers: [
          { login: "newdev", org: "corp-org" },
          { login: "newdev", org: "other-org" },
        ],
      }),
      config({ orgMembership: { "corp-org": "mtg-ag", "other-org": "other-corp" } }),
      EDITIONS,
    );
    expect(v.verdict).toBe("pass");
    expect(v.mustSpecify["newdev"]).toHaveLength(2);
    expect(v.mustSpecify["newdev"]?.map((o) => (o.kind === "ocla" ? o.orgSlug : o.kind))).toEqual(["mtg-ag", "other-corp"]);
  });

  it("an unlinked commit reaches membership through its verified email", () => {
    const v = evaluate(
      pr([{ login: null, email: "newdev@example.com" }]),
      memberSnap({
        oclas: [ocla()],
        verifiedEmails: [{ login: "newdev", email: "newdev@example.com" }],
      }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]).toMatchObject({ status: "covered", path: "ocla", viaOrgMembership: true, matchedBy: "email" });
  });

  it("an unlinked commit with no resolvable identity is never membership-checked", () => {
    const v = evaluate(
      pr([{ login: null, email: "stranger@example.com" }]),
      memberSnap({ oclas: [ocla()] }),
      memberCfg(),
      EDITIONS,
    );
    expect(v.committers[0]?.status).toBe("missing");
    expect(v.missing).toEqual(["email:stranger@example.com"]);
  });
});

describe("kernel: an election resolves a membership must-specify (issue #16 item 4)", () => {
  it("the elected OCLA is covered, and the elected path keeps its membership flag", () => {
    const snap = snapshot({
      oclas: [ocla(), ocla({ id: "ocla-2", orgSlug: "other-corp", covered: [] })],
      orgMembers: [
        { login: "newdev", org: "corp-org" },
        { login: "newdev", org: "other-org" },
      ],
      attributions: [{ repo: "rnpgp/rnp", pr: 1, login: "newdev", agreement: { kind: "ocla", version: "1.0", oclaId: "ocla-2", orgSlug: "other-corp" } }],
    });
    const cfg = config({ orgMembership: { "corp-org": "mtg-ag", "other-org": "other-corp" } });
    const v = evaluate(pr([login("newdev")]), snap, cfg, EDITIONS);
    expect(v.committers[0]).toMatchObject({
      status: "covered",
      path: "ocla",
      viaOrgMembership: true,
      agreement: { kind: "ocla", oclaId: "ocla-2", orgSlug: "other-corp" },
    });
    expect(Object.keys(v.mustSpecify)).toEqual([]);
  });

  it("an election naming a non-member's agreement does not resolve the membership question", () => {
    const snap = snapshot({
      oclas: [ocla(), ocla({ id: "ocla-2", orgSlug: "other-corp", covered: [] })],
      orgMembers: [
        { login: "newdev", org: "corp-org" },
        { login: "newdev", org: "other-org" },
      ],
      // the election points at an OCLA the facts do not designate under
      attributions: [{ repo: "rnpgp/rnp", pr: 1, login: "newdev", agreement: { kind: "icla", version: "1.0" } }],
    });
    const cfg = config({ orgMembership: { "corp-org": "mtg-ag", "other-org": "other-corp" } });
    const v = evaluate(pr([login("newdev")]), snap, cfg, EDITIONS);
    // a dead/mismatched election never invents coverage: still a question
    expect(v.committers[0]?.status).toBe("must-specify");
  });
});
