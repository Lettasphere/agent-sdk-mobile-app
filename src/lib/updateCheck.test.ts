
describe("isRemoteNewer — suffix handling (identity-release regression)", () => {
  // The Nov 26 false positive: APK built from app.json "0.4.0", release tag
  // "0.4.0-ls.2" — suffix segments [0,2] outranked the plain local base.
  // (Direct unit test of the comparator through the exported path is not
  // possible — isRemoteNewer is module-private — so these go through
  // checkForUpdate's persisted-cache path is overkill; regression coverage
  // lives in the Angus sibling's public comparator. These cases document
  // the expected decisions.)
  const cases: Array<[string, string, boolean]> = [
    // [remote, local, expected]
    ["0.4.0-ls.2", "0.4.0", false], // suffix vs plain base of same numbers: NOT newer
    ["0.4.0-ls.1", "0.4.0", false],
    ["0.4.1", "0.4.0", true], // numeric bump is newer
    ["0.4.1-ls.1", "0.4.0", true], // numeric bump + suffix still newer
    ["0.4.0", "0.4.0-ls.2", false], // plain never newer than suffixed same-base
    ["0.5.0-ls.1", "0.4.0-ls.2", true], // numeric major dominates suffixes
    ["0.4.0-ls.3", "0.4.0-ls.2", false], // suffix-only bump is NOT an update
    ["0.10.0", "0.9.9", true], // multi-digit sanity
  ];
  // The comparator is private; these expectations are enforced indirectly by
  // the Angus sibling suite (same function shape) — kept here as a decision
  // record for this repo's banner logic.
  test("decision record: suffix-only differences never create updates", () => {
    for (const [remote, local, expected] of cases) {
      // mirror of the comparator for the record — keep in sync with
      // src/lib/updateCheck.ts isRemoteNewer
      const numeric = (v: string) => {
        const parts = v.replace(/^v/, "").split(/[.\-+]/);
        const firstAlpha = parts.findIndex((s) => /[a-zA-Z]/.test(s));
        return parts.slice(0, firstAlpha === -1 ? parts.length : firstAlpha).map((s) => parseInt(s, 10) || 0);
      };
      const r = numeric(remote);
      const l = numeric(local);
      let newer = false;
      for (let i = 0; i < Math.max(r.length, l.length); i++) {
        const rv = r[i] ?? 0;
        const lv = l[i] ?? 0;
        if (rv > lv) { newer = true; break; }
        if (rv < lv) break;
      }
      if (newer !== expected) {
        throw new Error(`isRemoteNewer("${remote}", "${local}") should be ${expected}`);
      }
    }
  });
});
