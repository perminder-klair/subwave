// The playing file's own format on the Dash (GET /now-playing/file).
//
// Constants only. The controller backs a failed Navidrome lookup off for this
// long, and the Dash waits the same minute before it asks again, so the one
// number lives here and reaches the web through the schema mirror rather than
// as a copy that can drift.

/** A failed lookup is not retried before this: a Dash polling a down
 *  Navidrome must cost one call a minute, not twenty. */
export const FILE_FORMAT_RETRY_MS = 60_000;
