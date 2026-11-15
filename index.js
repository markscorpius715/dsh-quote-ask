/**
 * dsh-quote-ask — host half.
 *
 * The feature is a browser surface; this entry only has to exist so the Cordis
 * Loader scans the package, composes its `dsh.client` bundle, and keeps the
 * profile bundle row well-formed (same shape dsh-selection-ask uses: a host half
 * with an empty `apply`).
 *
 * @module dsh-quote-ask
 */

export const name = 'dsh-quote-ask'

export function apply() {
  // No host-side services: the browser half talks to the client services the
  // web app already publishes (sessions / slots / uiSession / conversation).
}
