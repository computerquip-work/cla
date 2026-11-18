import type { GithubApi } from "../github/api";

/**
 * Append-only record writing: one commit per record into the data
 * repo (docs/design.md §8). Corrections are NEW records — existing
 * files are never rewritten.
 *
 * A caller-supplied `record.id` is the IDEMPOTENCY KEY: the same
 * logical record (same login, same edition, same day) always lands on
 * the same path, so a double-POST race in the sign flow overwrites its
 * own file instead of appending a duplicate. The replayed PUT returns
 * 200 rather than 201 — accepted, because the path is derivable only
 * from the record's own key material.
 */

export type WriteDeps = {
  api: GithubApi;
  installationId: number;
  dataRepo: string;
  now: () => number;
  /** injectable id source (specs assert determinism); crypto UUID at runtime */
  newId?: () => string;
};

export async function appendRecord(deps: WriteDeps, namespace: string, record: Record<string, unknown>): Promise<{ path: string; commitSha: string }> {
  const supplied = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : undefined;
  const id = supplied ?? (deps.newId ?? (() => crypto.randomUUID()))();
  const d = new Date(deps.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const path = `${namespace}/${yyyy}/${mm}/${id}.json`;
  // The id is part of the record, not just its filename: the loader
  // identifies records (and revocations target them) by this field.
  const stored = { ...record, id };
  const body = {
    message: `record: ${namespace}/${id}`,
    content: Buffer.from(JSON.stringify(stored, null, 2), "utf8").toString("base64"),
  };
  const res = await deps.api.request(deps.installationId, "PUT", `/repos/${deps.dataRepo}/contents/${path}`, { body });
  if (res.status !== 201 && res.status !== 200) throw new Error(`record write failed (${namespace}): ${res.status}`);
  const doc = JSON.parse(res.body) as { commit?: { sha?: string } };
  return { path, commitSha: doc.commit?.sha ?? "unknown" };
}
