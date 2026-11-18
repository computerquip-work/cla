import { b64UrlEncode } from "./oidc";
import { isSpdxId } from "../spdx";

/**
 * Signed completion-link tokens for the comment-command flow
 * (docs/design.md §3.12): `@ribose-cla agree` -> the bot replies with
 * `/icla/complete?t=<token>`; the token binds (repo, pr, login) for
 * 10 minutes and the portal only completes the signature when the
 * freshly-proven handle equals the token's login.
 */

const encoder = new TextEncoder();

export type CompletionToken = {
  repo: string;
  pr: number;
  login: string;
  exp: number;
};

async function hmac(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(content));
  return b64UrlEncode(new Uint8Array(sig));
}

const timingSafeEq = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function signCompletionToken(secret: string, data: { repo: string; pr: number; login: string }, now: number): Promise<string> {
  const payload: CompletionToken = { ...data, exp: Math.floor(now / 1000) + 600 };
  const body = b64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readCompletionToken(secret: string, token: string | undefined, now: number): Promise<CompletionToken | undefined> {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEq(sig, await hmac(secret, body))) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64"))) as CompletionToken;
    if (claims.exp * 1000 <= now) return undefined;
    if (typeof claims.repo !== "string" || typeof claims.pr !== "number" || typeof claims.login !== "string") return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** The exact command (case-insensitive, trimmed). */
export const AGREE_COMMAND = "@ribose-cla agree";
export const isAgreeCommand = (body: string): boolean => parseAgreeCommand(body) !== undefined;

/** The command grammar (issue #57, Microsoft parity):
 *  `@ribose-cla agree` - the ICLA completion link;
 *  `@ribose-cla agree icla` - elect the ICLA on a must-specify PR;
 *  `@ribose-cla agree company="slug"` (quotes optional) - elect the
 *  org's OCLA when on the roster, else file a join request. */
export type AgreeCommand =
  | { kind: "icla-completion" }
  | { kind: "icla-elect" }
  | { kind: "company"; company: string };

export function parseAgreeCommand(body: string): AgreeCommand | undefined {
  const t = body.trim().toLowerCase();
  if (t === AGREE_COMMAND) return { kind: "icla-completion" };
  if (t === `${AGREE_COMMAND} icla`) return { kind: "icla-elect" };
  const m = /^@ribose-cla agree company\s*=\s*(?:"([^"]+)"|(\S+))$/.exec(t);
  if (m) {
    const company = (m[1] ?? m[2] ?? "").trim();
    if (company) return { kind: "company", company };
  }
  return undefined;
}

/** The clause-7 declaration command (issues #63, #118): the whole
 *  comment, case-insensitive —
 *  `@ribose-cla third-party: <name> (SPDX: <id>)`.
 *  The SPDX id is MANDATORY: an optional one is a gate a contributor can
 *  step around by omitting it, which is exactly what #118 prevents. One
 *  identifier (or `LicenseRef-...`), not an expression; expressions need
 *  list semantics counsel has not given. */
const THIRD_PARTY_HEAD = /^@ribose-cla third-party:\s*/i;
const THIRD_PARTY_SPDX = /\s*\(SPDX:\s*([^)]*)\)\s*$/i;

export type ThirdPartyParse =
  | { kind: "declaration"; name: string; spdx: string }
  | { kind: "malformed"; reason: string };

export function parseThirdPartyCommand(body: string): ThirdPartyParse | undefined {
  const t = body.trim();
  if (!THIRD_PARTY_HEAD.test(t)) return undefined;
  const rest = t.replace(THIRD_PARTY_HEAD, "").trim();
  if (!rest) return { kind: "malformed", reason: "a third-party name is required" };
  const m = THIRD_PARTY_SPDX.exec(rest);
  if (!m) return { kind: "malformed", reason: "an SPDX identifier is required" };
  const spdx = (m[1] ?? "").trim();
  const name = rest.slice(0, rest.length - m[0].length).trim();
  if (!name) return { kind: "malformed", reason: "a third-party name is required" };
  if (!spdx) return { kind: "malformed", reason: "an SPDX identifier is required" };
  if (!isSpdxId(spdx)) return { kind: "malformed", reason: `"${spdx}" is not a single SPDX identifier` };
  return { kind: "declaration", name, spdx };
}

export type ThirdPartyDecision =
  | { allowed: true; spdx: string }
  | { allowed: false; reason: string; message: string };

/** The accepted-license gate (issue #118). `undefined` is UNCONFIGURED and
 *  `[]` is an explicit "nothing accepted": both refuse, in different words,
 *  because a declaration that passes without a list is the silent pass the
 *  issue exists to prevent. Matching is case-insensitive; the configured
 *  spelling is returned so records and markings stay canonical. */
export function thirdPartyGate(accepted: string[] | undefined, spdx: string): ThirdPartyDecision {
  if (accepted === undefined) {
    return {
      allowed: false,
      reason: "accepted-license list unconfigured",
      message: "Third-party declarations are not available: Ribose has not configured its counsel-owned accepted-license list, so no third-party material can be accepted. A maintainer must set legal.third_party.accepted_licenses.",
    };
  }
  if (accepted.length === 0) {
    return {
      allowed: false,
      reason: "no third-party material accepted",
      message: "Ribose does not currently accept third-party material in contributions, so this declaration is refused.",
    };
  }
  const hit = accepted.find((a) => a.toLowerCase() === spdx.toLowerCase());
  if (!hit) {
    return {
      allowed: false,
      reason: `SPDX ${spdx} not accepted`,
      message: `**${spdx}** is not on Ribose's accepted-license list, so this third-party declaration is refused. Accepted licenses: ${accepted.join(", ")}.`,
    };
  }
  return { allowed: true, spdx: hit };
}

/** The meta commands (2026-11-18, the rnp#2573 discoverability work):
 *  `@ribose-cla help` - everything the check supports;
 *  `@ribose-cla status` - the caller's own live coverage;
 *  `@ribose-cla recheck` - re-run the evaluation on the current head. */
export type MetaCommand = "help" | "status" | "recheck";

export function parseMetaCommand(body: string): MetaCommand | undefined {
  const t = body.trim().toLowerCase();
  if (t === "@ribose-cla help") return "help";
  if (t === "@ribose-cla status") return "status";
  if (t === "@ribose-cla recheck") return "recheck";
  return undefined;
}
