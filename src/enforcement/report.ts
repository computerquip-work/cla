import type { Committer, Config, Editions, StoreSnapshot } from "@riboseinc/cla-kernel";
import { evaluate } from "@riboseinc/cla-kernel";
import type { EnforcementDeps } from "./handler";
import { kernelEditions } from "../config";
import { loadSnapshot } from "../store/load";
import { makeListRecords } from "../store/github-store";
import { resolveOrgMemberships } from "./org-membership";

/**
 * The repo-centric coverage report (issue #88): for every installed
 * repository, its recent contributors and each one's live state —
 * signed / stale / outstanding / must-specify / allowlist / CI account,
 * with the separate-agreement registry flagged. One bounded step at a
 * time, cursor-persisting like the installation backfill, because an
 * estate is thousands of repositories and each costs a commits call and
 * a license call.
 *
 * The App cannot read branch protection (it holds no administration
 * permission — constraint 7), so "required check armed" is NOT part of
 * this report: that answer lives in #53 and in the repository settings.
 * The report says so in `notes` rather than guessing.
 *
 * The license column (issue #116) is Licensee detection, an observation
 * and never a legal opinion: it makes "which repos have which needs" a
 * standing view while the scope-bound edition mechanism waits on counsel.
 * A BUSL repository is visible here; nothing here judges it.
 */

const PER_PAGE = 100;
export const DEFAULT_REPOS_PER_STEP = 10;
export const DEFAULT_COMMIT_WINDOW = 25;

export type CoverageCursor = { page: number; offset: number };

export type PersonState = "signed" | "stale" | "outstanding" | "must-specify" | "allowlist" | "ci-account";

export type ContributorRow = {
  login: string | null;
  email: string | null;
  state: PersonState;
  path?: "icla" | "ocla" | "separate-agreement";
  /** Which OCLA covers the person (the org slug) — set only on an
   *  `ocla` path; an ICLA row names no organization. */
  org_slug?: string;
  /** Covered by GitHub-org membership under the OCLA rather than a
   *  named Schedule A row (issue #16 item 4). */
  via_org_membership?: boolean;
  edition?: string;
  matched_by?: "login" | "email";
  /** The login is covered under a separate written agreement: the click
   *  still gates, only the attribution differs (never rendered publicly). */
  under_separate_agreement?: boolean;
  /** Agreement options when the person must specify which one applies. */
  options?: string[];
  last_commit?: string;
};

export type RepoCoverageRow = {
  repo: string;
  in_scope: boolean;
  /** Which agreement instrument this repository's pull requests require
   *  (the scope binding). `standard` is the deployed ICLA/OCLA pair;
   *  `excluded` is coverage.repos_without_cla. A scope-bound edition for
   *  a restrictive license is riboseinc/cla#116 and will name itself
   *  here once counsel decides. */
  scope: RepoScope;
  /** GitHub Licensee's detection for the repository. */
  license: RepoLicense;
  note?: string;
  contributors: ContributorRow[];
};

export type RepoScope = "standard" | "excluded";

/** What the repo's LICENSE file actually says. The three states are kept
 *  apart because collapsing them would read an unanswered lookup as "no
 *  license", and an all-rights-reserved repo as ordinary. */
export type RepoLicense = {
  /** SPDX identifier Licensee detected (e.g. "BUSL-1.1"), or null when
   *  there is no license file Licensee can identify. */
  spdx: string | null;
  /** declared: Licensee identified a license; none: no license file
   *  (all rights reserved); unreadable: the App could not ask. */
  state: "declared" | "none" | "unreadable";
  /** Present only on `unreadable`: why the inventory does not know. */
  note?: string;
};

export type RepoCoverageReport = {
  org: string | null;
  total: number;
  repos: RepoCoverageRow[];
  next: CoverageCursor | null;
  window: number;
  notes: string[];
};

const normalize = (s: string): string => s.trim().toLowerCase();

/** Any record matching this identity, regardless of liveness — the
 *  difference between "signed an old edition" and "never signed". */
function hasHistoricalRecord(
  c: Committer,
  snap: StoreSnapshot,
): { icla: boolean; ocla: boolean } {
  const login = c.login ? normalize(c.login) : null;
  const email = c.email ? normalize(c.email) : null;
  const matchesLogin = (l: string) => login !== null && normalize(l) === login;
  const matchesEmail = (e?: string | null) => email !== null && e !== null && e !== undefined && normalize(e) === email;
  return {
    icla: snap.iclas.some((r) => matchesLogin(r.githubLogin) || matchesEmail(r.email)),
    ocla: snap.oclas.some((o) => o.covered.some((row) => matchesLogin(row.githubLogin) || matchesEmail(row.email))),
  };
}

function isBotAuthor(author: Record<string, unknown> | undefined): boolean {
  if (!author) return false;
  if (author["type"] === "Bot") return true;
  const login = author["login"];
  return typeof login === "string" && login.endsWith("[bot]");
}

type CommitSample = { committers: Committer[]; lastCommit: Map<string, string> };

/** The repo's recent commits, deduped by identity, newest first (the
 *  commits endpoint returns reverse-chronological order). */
function sampleCommitters(commits: Array<Record<string, unknown>>, window: number): CommitSample {
  const byKey = new Map<string, Committer>();
  const lastCommit = new Map<string, string>();
  for (const c of commits.slice(0, window)) {
    const author = c["author"] && typeof c["author"] === "object" ? (c["author"] as Record<string, unknown>) : undefined;
    const gitAuthor = c["commit"] && typeof c["commit"] === "object" ? (c["commit"] as Record<string, unknown>)["author"] : undefined;
    const git = gitAuthor && typeof gitAuthor === "object" ? (gitAuthor as Record<string, unknown>) : {};
    const login = typeof author?.["login"] === "string" ? (author["login"] as string) : null;
    const email = typeof git["email"] === "string" ? (git["email"] as string) : null;
    if (login === null && email === null) continue;
    const key = login ?? `email:${email}`;
    if (byKey.has(key)) continue;
    const committer: Committer = { login, email, isBot: isBotAuthor(author) };
    byKey.set(key, committer);
    const date = typeof git["date"] === "string" ? (git["date"] as string) : undefined;
    if (date) lastCommit.set(key, date);
  }
  return { committers: [...byKey.values()], lastCommit };
}

const keyOf = (c: Committer): string => c.login ?? `email:${c.email ?? ""}`;

/** GitHub Licensee's answer for one repository. A 404 is the documented
 *  "no license file" answer, and is a fact about the repo; every other
 *  non-200 is the App's failure to ask, and must not be reported as a
 *  repo with no license. */
export function licenseFromResponse(status: number, body: string): RepoLicense {
  if (status === 404) return { spdx: null, state: "none" };
  if (status !== 200) return { spdx: null, state: "unreadable", note: `license lookup failed: ${status}` };
  let doc: { license?: { spdx_id?: unknown } | null };
  try {
    doc = JSON.parse(body) as typeof doc;
  } catch {
    return { spdx: null, state: "unreadable", note: "license response unparseable" };
  }
  const spdx = typeof doc.license?.spdx_id === "string" ? doc.license.spdx_id.trim() : "";
  if (!spdx) return { spdx: null, state: "unreadable", note: "Licensee returned no SPDX identifier" };
  // "NOASSERTION" is a real SPDX value: a license file exists that
  // Licensee cannot map. Keep it verbatim — it is not "no license".
  return { spdx, state: "declared" };
}

/** The per-repo table: kernel precedence decides coverage, this maps it
 *  to the operator's state words (matching the roster's vocabulary). */
export function repoRow(
  repo: string,
  inScope: boolean,
  commits: Array<Record<string, unknown>>,
  snap: StoreSnapshot,
  cfg: Config,
  editions: Editions,
  window: number,
  license: RepoLicense,
): RepoCoverageRow {
  const { committers, lastCommit } = sampleCommitters(commits, window);
  const org = repo.split("/")[0] ?? "";
  const name = repo.split("/")[1] ?? "";
  const verdict = evaluate({ context: { org, repo: name, pr: 0 }, committers }, snap, cfg, editions);
  const ids = committers.filter((c) => !c.isBot);

  const rows: ContributorRow[] = [];
  let i = 0;
  for (const c of committers) {
    const base = { login: c.login, email: c.email ?? null, last_commit: lastCommit.get(keyOf(c)) };
    if (c.isBot) {
      rows.push({ ...base, state: "ci-account" });
      continue;
    }
    const v = verdict.committers[i++];
    if (!v) continue;
    if (v.status === "covered") {
      if (v.path === "allowlist") {
        rows.push({ ...base, state: "allowlist" });
      } else {
        rows.push({
          ...base,
          state: "signed",
          path: v.path,
          ...(v.agreement && "orgSlug" in v.agreement ? { org_slug: v.agreement.orgSlug } : {}),
          ...(v.viaOrgMembership ? { via_org_membership: true } : {}),
          edition: v.agreement?.version,
          matched_by: v.matchedBy,
          ...(v.underSeparateAgreement ? { under_separate_agreement: true } : {}),
        });
      }
    } else if (v.status === "must-specify") {
      rows.push({
        ...base,
        state: "must-specify",
        matched_by: v.matchedBy,
        options: v.options.map((o) => (o.kind === "icla" ? `icla ${o.version}` : `${o.orgSlug} ocla ${o.version}`)),
      });
    } else {
      // Missing: a record may exist but be stale (an older edition) — the
      // operator needs that difference, "never signed" vs "signed an old one".
      const historical = hasHistoricalRecord(c, snap);
      rows.push({ ...base, state: historical.icla || historical.ocla ? "stale" : "outstanding" });
    }
  }
  return { repo, in_scope: inScope, scope: inScope ? "standard" : "excluded", license, contributors: rows };
}

export async function repoCoverageStep(
  deps: EnforcementDeps,
  installationId: number,
  cursor: CoverageCursor = { page: 1, offset: 0 },
  chunk: number = DEFAULT_REPOS_PER_STEP,
  window: number = DEFAULT_COMMIT_WINDOW,
): Promise<RepoCoverageReport> {
  const list = await deps.api.request(installationId, "GET", `/installation/repositories?per_page=${PER_PAGE}&page=${cursor.page}`);
  if (list.status !== 200) throw new Error(`installation repository listing failed: ${list.status}`);
  const body = JSON.parse(list.body) as { total_count?: number; repositories?: Array<{ full_name?: string }> };
  const page = (body.repositories ?? []).map((r) => r.full_name).filter((n): n is string => typeof n === "string");
  const slice = page.slice(cursor.offset, cursor.offset + chunk);

  const editions = kernelEditions(deps.config);
  const loaded = await loadSnapshot(
    { listRecords: makeListRecords(deps.api, deps.config.github.dataInstallationId, deps.config.github.dataRepo) },
    editions,
  );
  const { snapshot } = loaded;
  // The separate-agreement registry is static config since #89 — inject it
  // exactly as the enforcement path does, or the flag is dead code here.
  snapshot.msaLogins = deps.config.instance.separateAgreement?.logins ?? [];

  const repos: RepoCoverageRow[] = [];
  // Logins already asked about (member or not) this step: a negative
  // answer produces no fact, so without this the same outstanding
  // login would be re-queried for every repository in the chunk.
  const askedLogins = new Set<string>();
  for (const repo of slice) {
    // The inventory fact is about the repo, not about its people: fetch it
    // even for excluded repos, where the operator still asks what the
    // estate contains (issue #116).
    const licRes = await deps.api.request(installationId, "GET", `/repos/${repo}/license`);
    const license = licenseFromResponse(licRes.status, licRes.body);
    const inScope = !deps.config.coverage.reposWithoutCla.includes(repo.toLowerCase());
    if (!inScope) {
      // Excluded by config: enforcement does not apply, so the people are
      // not relevant to the operator's question — the posture is.
      repos.push({ repo, in_scope: false, scope: "excluded", license, contributors: [] });
      continue;
    }
    const res = await deps.api.request(installationId, "GET", `/repos/${repo}/commits?per_page=${window}`);
    if (res.status !== 200) {
      repos.push({
        repo,
        in_scope: true,
        scope: "standard",
        license,
        note: res.status === 409 ? "empty repository (no commits)" : `commit listing failed: ${res.status}`,
        contributors: [],
      });
      continue;
    }
    const commits = JSON.parse(res.body);
    let row = repoRow(repo, true, commits, snapshot, deps.config, editions, window, license);
    // Coverage by GitHub-org membership (issue #16 item 4): the report
    // answers with the same facts the enforcement path uses, or it would
    // send the operator chasing signatures from people who hold none.
    // Only outstanding/stale logins are asked about — the "otherwise
    // uncovered" rule — and each login is asked once per step.
    const orgMembership = deps.config.coverage.orgMembership;
    if (orgMembership && Object.keys(orgMembership).length > 0) {
      const asked = row.contributors
        .filter((r) => (r.state === "outstanding" || r.state === "stale") && r.login && !askedLogins.has(r.login.toLowerCase()))
        .map((r) => r.login!);
      for (const l of asked) askedLogins.add(l.toLowerCase());
      if (asked.length > 0) {
        const facts = await resolveOrgMemberships(deps.api, orgMembership, asked);
        const prior = snapshot.orgMembers ?? [];
        const seen = new Set(prior.map((f) => `${f.login.toLowerCase()}|${f.org.toLowerCase()}`));
        for (const f of facts) {
          const key = `${f.login.toLowerCase()}|${f.org.toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            prior.push(f);
          }
        }
        snapshot.orgMembers = prior;
        // Re-evaluate: a fact may cover someone the first pass called outstanding.
        row = repoRow(repo, true, commits, snapshot, deps.config, editions, window, license);
      }
    }
    repos.push(row);
  }

  const consumed = cursor.offset + slice.length;
  const next: CoverageCursor | null =
    page.length === 0 || (consumed >= page.length && page.length < PER_PAGE)
      ? null
      : consumed >= page.length
        ? { page: cursor.page + 1, offset: 0 }
        : { page: cursor.page, offset: consumed };
  const short = (sha: string): string => sha.slice(0, 8);
  return {
    org: slice[0]?.split("/")[0] ?? null,
    total: body.total_count ?? page.length,
    repos,
    next,
    window,
    notes: [
      // A store that loaded nothing reads as "everyone outstanding" — a
      // whole-estate gap that looks like ordinary drift. The report says
      // what it actually loaded, and names rejected records (fail-visible).
      `records loaded: ${snapshot.iclas.length} ICLA, ${snapshot.oclas.length} OCLA${loaded.rejected.length > 0 ? `; ${loaded.rejected.length} rejected: ${loaded.rejected.slice(0, 5).map((r) => `${r.path} (${r.reason})`).join(", ")}` : ""}`,
      // Which editions THIS deploy evaluated against, and whether the data
      // repo agrees with them (issue #104): a stale bundle reads a covered
      // person as stale (or outstanding, when the record is missing), and
      // without this line that looks exactly like ordinary drift. Capture
      // this with notes[0] when reporting.
      `evaluating as: icla v${editions.icla.version} sha ${short(editions.icla.textSha256)}, ocla v${editions.ocla.version} sha ${short(editions.ocla.textSha256)} — the editions this deployment compiled; compare with /editions`,
      ...(loaded.editionDivergences.length > 0
        ? [
            `edition mismatch — this deployment is stale, and the states below are not trustworthy: ${loaded.editionDivergences
              .slice(0, 3)
              .map((d) => `${d.path} declares ${d.kind} v${d.version} sha ${short(d.recordSha256)}, this deployment compiled sha ${short(d.currentSha256)}`)
              .join("; ")}. Editions are content-addressed, so these cannot both be correct; redeploy from current instance config (riboseinc/cla#104)`,
          ]
        : []),
      "required-check status is not readable by the App (it holds no administration permission) — tracked per repo in riboseinc/cla#53",
      // The license inventory (issue #116): an observation, and the three
      // states stay distinct so an unanswered lookup never reads as "no
      // license file". Scope-bound editions await counsel.
      "license is GitHub Licensee's per-repository detection (state `none` = no license file Licensee can identify, i.e. all rights reserved; `unreadable` = the App could not ask); the scope column says which instrument set a repo's PRs require (`standard` = the deployed ICLA/OCLA pair, `excluded` = coverage.repos_without_cla) — scope-bound editions are riboseinc/cla#116, pending counsel",
      "excluded repositories (coverage.repos_without_cla) are reported with in_scope=false and no contributors",
    ],
  };
}
