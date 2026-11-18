# Counsel brief — BUSL-scoped contributions under the Ribose ICLA/OCLA

**Status:** draft prepared by engineering for Ribose counsel, via the owner.
**Not legal advice:** §3 below is engineering's reading of the instruments and
needs counsel's verification against the executed texts.
**Tracking:** riboseinc/cla#116 (decision), #117 (license inventory, in review),
#118 (clause-7 SPDX gate), #119 (scope-bound editions).

---

## 1. The decision requested

May contributors' work continue to be accepted under the current ICLA/OCLA 1.0
for repositories distributed under a restrictive license — specifically the
BUSL-1.1 terms of `conormis/platform` — or does Ribose need a scope-bound
supplement (BCLA-style) before accepting them?

Three outcomes are possible; one is needed to unblock #119:

- **A. Current instruments suffice.** The recipient grant in §2 is accepted as
  it stands; no new instrument.
- **B. A scope-bound supplement is required.** Counsel settles its text; Ribose
  asks for it, by name, on pull requests in the designated scopes.
- **C. Contributions to BUSL-scoped repositories are not accepted** under the
  current instruments (a refusal posture, or a different instrument such as an
  assignment — the latter is outside #116's scope).

---

## 2. Facts (verified 2026-11-18)

- `conormis/platform` is **private**, default branch `main`. Its root `LICENSE`
  is a Business Source License 1.1 text with these parameters:
  - **Licensor:** Ribose Limited
  - **Licensed Work:** Conormis Platform. The Licensed Work is Copyright (c) 2026
    Ribose Limited.
  - **Additional Use Grant:** None
  - **Change Date:** four years from the date each version of the Licensed Work
    is published
  - **Change License:** GNU Affero General Public License version 3.0
    (AGPL-3.0-only)
- GitHub's Licensee reports this file as **`NOASSERTION`** — it does not map the
  text to `BUSL-1.1`. This matters to tooling (scope cannot be inferred from
  license detection), not to the legal analysis.
- The other `conormis` repositories carry **no LICENSE file**: `TODO`,
  `fixtures` (private), `conormis.github.io`, `.github` (public). All rights
  reserved; the public receives nothing from them today.
- The wider Ribose estate is permissive (BSD-3-Clause / MIT) or consists of
  unlicensed meta repositories.

Inventory detail is in #117; it reports `declared` / `none` / `unreadable`
separately and preserves `NOASSERTION` rather than flattening it.

---

## 3. What the current instruments grant (engineering reading — verify)

The ICLA and OCLA 1.0 are the Apache Software Foundation ICLA/CCLA pattern.

- **§2** grants Ribose **and recipients of software distributed by Ribose** a
  perpetual, worldwide, irrevocable, royalty-free license to reproduce, prepare
  derivative works, publicly display and perform, **sublicense, and distribute**
  — with **no condition on the license Ribose distributes under**.
- Contributors **retain copyright** ("You reserve all right, title and
  interest"). Ribose cannot re-stamp contributor files, strip notices, or
  register their copyright; consolidation would require an assignment (a
  different legal act).

The exact texts are counsel-owned and live in the private instance repository
(`ribosei/cla-instance`). The deployment compiles the current editions and
reports their sha256 (`/editions`, and the `evaluating as:` line in
`/admin/repos-coverage`); counsel should confirm the review is against those
hashes.

**The open question.** "Recipients of software distributed by Ribose" appears to
give recipients a **direct grant from each contributor**. A recipient of the
BUSL work would then arguably hold contributor-granted rights to the embedded
contributions that BUSL's production restrictions do not limit. MariaDB
addressed this exact question with a **BCLA**: the grant extends explicitly to
BUSL and the Change License, and recipients take **via those licenses only**.
This is cited in #116 as the main reason BUSL projects do not reuse the Apache
ICLA.

---

## 4. Questions for counsel

Each is written to be answerable; please answer the ones that are within scope
and mark the rest.

1. **§2 confirmed?** Against the executed ICLA/OCLA texts, is the grant to
   "recipients of software distributed by Ribose" a direct, independent grant
   from each contributor — i.e. not merely a grant that operates through
   Ribose's outbound license?
2. **Material risk?** If direct, does a recipient of a BUSL-licensed Ribose
   distribution thereby obtain rights to the embedded contributions that permit
   production use beyond the Additional Use Grant (here, `None`)? If the answer
   is "arguable but not settled", say so; the engineering posture defaults to
   fail-closed.
3. **Is a scope-bound supplement the cure?** If so, what must it contain? Our
   understanding of the BCLA shape is:
   (a) the grant to Ribose is unchanged;
   (b) recipients take only through Ribose's outbound license;
   (c) sublicense and distribution are limited to the outbound license in force,
       and to the Change License from the Change Date;
   (d) no direct recipient grant independent of (b) and (c).
   Please correct or replace this.
4. **Form and signature.** May the supplement be a new **content-addressed
   edition** of the ICLA, clicked once under the existing signature flow, or
   must it be a distinct instrument with its own signature? Do existing ICLA
   signers need to sign it for scoped contributions only? (Editions are
   immutable; a new text is a new edition; signatures bind to the text hash.)
5. **Scope granularity.** May one general "restrictive-license supplement" cover
   any license Ribose designates, or must each license have its own text?
   Engineering can map `org/repo` (or an org) to an instrument; counsel should
   say whether an org-wide mapping is acceptable or each repository must be
   named.
6. **Copyright and notices.** Confirm that the retention clause permits Ribose
   to distribute contributor-containing works under BUSL and to convert to
   AGPL-3.0 at the Change Date. Are any notices required in files containing
   contributor code (beyond the repository's existing `LICENSE`/`NOTICE`)?
7. **Clause-7 third-party material.** What is the accepted-license list, and
   must every third-party declaration carry an SPDX identifier? What disposition
   do you want for BUSL, AGPL, GPL, SSPL and similar licenses in third-party
   material? (This gates #118; it does not depend on the A/B/C outcome.)
8. **Evidence.** What must engineering retain to make the grant provable —
   instrument and edition hash, scope, identity binding, timestamp, PR/commit?
   The current records are append-only and content-addressed; tell us if
   anything further is required.
9. **Existing contributions.** For work already merged under the current ICLA
   before any supplement takes effect, is remediation needed, or does the
   existing grant cover it (under either A or B)?
10. **Additional Use Grant: None.** Does the absence of an additional use grant
    change the analysis or the supplement's wording?

---

## 5. What engineering does under each outcome

| Outcome | Engineering consequence |
|---|---|
| **A** | No scope instrument. #119 closes as not needed. #117's `scope` field keeps `standard`/`excluded`. |
| **B** | #119 builds the scope map, the supplement edition, the check that names the missing instrument, and the one-click signing page. Records carry scope + edition. The report's `scope` field reads the map. |
| **C** | #119 builds a refusal path instead of a signing path: a scoped PR fails closed with an honest reason. Assignment remains a separate, counsel-drafted instrument (#116 non-goal). |

Under all three, #118 proceeds once the accepted-license list in Q7 is supplied.
#117 is unaffected.

## 6. Engineering constraints counsel should assume

- **Content-addressed editions:** `{kind, version, text_sha256}`. A changed text
  is a new edition; old signatures read stale lazily; there are no migration
  jobs. A supplement cannot be slipped into an existing edition.
- **Append-only records:** signatures and declarations are never rewritten;
  corrections are new records.
- **Instance-agnostic:** scopes and editions are deployment config; a second
  instance must boot config-only.
- **Fail-closed:** an unconfigured or unreadable scope fails the check honestly;
  it never falls back silently to the standard instruments.
- **Least privilege:** the app cannot configure branch protection; blocking is
  the required status check, set by humans.

---

## Annex A — conormis license inventory (public-API facts)

| Repository | Visibility | Licensee | LICENSE file |
|---|---|---|---|
| `conormis/platform` | private | `NOASSERTION` | `LICENSE` (BUSL-1.1 text, parameters in §2) |
| `conormis/TODO` | private | none | — |
| `conormis/fixtures` | private | none | — |
| `conormis/conormis.github.io` | public | none | — |
| `conormis/.github` | public | none | — |

## Annex B — references

- riboseinc/cla#116 — the audit and the decision (this brief)
- riboseinc/cla#117 — coverage report license inventory (in review)
- riboseinc/cla#118 — clause-7 SPDX gate
- riboseinc/cla#119 — scope-bound editions
- riboseinc/cla#63 — the clause-7 declaration as built
- riboseinc/cla#88 — the coverage report
- riboseinc/cla#104 — content-addressed editions and stale-deployment handling
- riboseinc/cla#100 — the static separate-agreement registry (unchanged)
- MariaDB's Business Source License Contributor License Agreement (BCLA) —
  cited in #116 as the precedent for the recipient-grant fix.
