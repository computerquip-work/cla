/**
 * One SPDX license identifier — or a `LicenseRef-...` — never an
 * expression (issue #118: the accepted-license list is a list of ids).
 * Shared by the config validator and the declaration grammar so the two
 * can never drift: a value the config accepts must be a value the
 * command can express, and vice versa.
 */

export const SPDX_ID = /^[A-Za-z0-9](?:[A-Za-z0-9.+-]*[A-Za-z0-9+])?$/;

export const isSpdxId = (s: string): boolean => SPDX_ID.test(s);
