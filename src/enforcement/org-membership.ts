import type { PrVerdict, StoreSnapshot } from "@riboseinc/cla-kernel";
import type { AppConfig } from "../config";
import type { GithubApi } from "../github/api";

/**
 * Coverage by GitHub-org membership (issue #16 item 4) — the transport
 * leg. The kernel stays pure: it reads `snapshot.orgMembers` as plain
 * facts against the config's `orgMembership` map; this module is the
 * only place that asks GitHub who is a member of what.
 *
 * Designated, never self-executing: a fact only means anything together
 * with a LIVE OCLA for the mapped slug — the signature remains the
 * coverage, membership only names who it covers.
 *
 * Fail-closed: the App must be installed on every mapped org (with the
 * Members permission). A refusal — not installed, 403, any unexpected
 * status — THROWS with the honest reason so the caller surfaces a
 * failure; an unverifiable membership never quietly reads as "covered"
 * or as "not covered, please sign".
 */

export type OrgMembershipFact = { login: string; org: string };

/** Resolve GitHub-org membership facts for the given logins.
 *  Config keys are lowercase by contract (parseConfig normalizes). */
export async function resolveOrgMemberships(
  api: GithubApi,
  orgMembership: Record<string, string>,
  logins: string[],
): Promise<OrgMembershipFact[]> {
  const orgs = [...new Set(Object.keys(orgMembership).map((o) => o.trim().toLowerCase()).filter(Boolean))];
  const wanted = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (orgs.length === 0 || wanted.length === 0) return [];

  const facts: OrgMembershipFact[] = [];
  for (const org of orgs) {
    // The question is asked with the MAPPED ORG's own installation: an
    // installation token only ever sees its own organization.
    const inst = await api.appRequest("GET", `/orgs/${org}/installation`);
    if (inst.status === 404) {
      throw new Error(`coverage.org_membership maps the GitHub org "${org}", but the App is not installed on it`);
    }
    if (inst.status !== 200) throw new Error(`installation lookup for GitHub org "${org}" failed: ${inst.status}`);
    const installationId = (JSON.parse(inst.body) as { id?: number }).id;
    if (!installationId) throw new Error(`installation lookup for GitHub org "${org}" returned no id`);

    for (const login of wanted) {
      const res = await api.request(installationId, "GET", `/orgs/${org}/members/${encodeURIComponent(login)}`);
      if (res.status === 204) {
        facts.push({ login, org });
      } else if (res.status !== 404) {
        // 404 is GitHub's documented "not a member" answer. Anything
        // else — 403 means the Members permission is missing — is a
        // verification FAILURE and must not be read as an answer.
        throw new Error(
          `GitHub org membership check ${org}/${login} failed: ${res.status}` +
            (res.status === 403 ? " (the App needs the Members: read permission on that organization)" : ""),
        );
      }
    }
  }
  return facts;
}

/** Two-pass evaluation: run the kernel once, resolve membership ONLY for
 *  the committers that came back `missing` (the design's "otherwise
 *  uncovered" rule — a covered committer never costs an API call), then
 *  run it again with the facts injected. Config OFF, or nothing
 *  uncovered: exactly one pass, zero GitHub calls. */
export async function evaluateWithOrgMembership(
  api: GithubApi,
  config: AppConfig,
  snapshot: StoreSnapshot,
  run: () => PrVerdict,
): Promise<PrVerdict> {
  const first = run();
  const map = config.coverage.orgMembership;
  if (!map || Object.keys(map).length === 0) return first;
  const uncovered = [
    ...new Set(first.committers.flatMap((c) => (c.status === "missing" && c.login ? [c.login.toLowerCase()] : []))),
  ];
  if (uncovered.length === 0) return first;
  const prior = snapshot.orgMembers ?? [];
  const seen = new Set(prior.map((f) => `${f.login.toLowerCase()}|${f.org.toLowerCase()}`));
  for (const f of await resolveOrgMemberships(api, map, uncovered)) {
    const key = `${f.login.toLowerCase()}|${f.org.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      prior.push(f);
    }
  }
  snapshot.orgMembers = prior;
  return run();
}
