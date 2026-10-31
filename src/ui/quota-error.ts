/** True for the exception shapes a save throws when it runs out of room on disk
 *  (or hits a storage quota): the browser's QuotaExceededError - native File
 *  System Access write to a full disk, or an over-quota storage write - including
 *  the wrapped/renamed variants where the DOMException subclass is lost but the
 *  name or message survives worker error forwarding. Lets the export catch
 *  map a no-room failure to clear, actionable guidance instead of leaking the
 *  raw "...exceed its storage quota" text to the user.
 *
 *  Pure (aside from the DOMException global) so the matcher is unit-testable. */
export function isQuotaExceededError(err: unknown): boolean {
    // Standard shape: DOMException with the named subclass or the legacy code 22.
    if (err instanceof DOMException && (err.name === "QuotaExceededError" || err.code === 22)) {
        return true;
    }
    // Wrapped/re-thrown: the subclass is gone but the name is preserved on a
    // plain Error or object after crossing a worker boundary.
    if (typeof err === "object" && err !== null && "name" in err) {
        if ((err as { name?: unknown }).name === "QuotaExceededError") return true;
    }
    // Last resort: match the message text. Kept narrow to avoid false positives
    // on unrelated "quota" wording.
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return /storage quota|exceed.{0,12}quota|quota.{0,12}exceed|no space left|enospc|disk (?:is )?full/.test(message);
}
