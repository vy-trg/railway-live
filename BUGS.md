## Map tiles showed "Access blocked 403" after adding helmet (3 Nov 2026)

**What happened:** After adding helmet, the map looked fine at first, but zooming in showed OpenStreetMap "Access blocked" tiles.

**Cause:** helmet sets `Referrer-Policy: no-referrer` by default. OpenStreetMap's tile usage policy requires a Referer, so new tile requests were refused. Tiles already in the browser cache still showed, which hid the problem until I zoomed.

**Fix:** `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }`, so other sites only see the app's origin.

**Lesson:** Security defaults can break third-party services. Test the whole user flow after a change, not just the first screen, and use a hard reload so the cache doesn't hide problems.

## Secret scanning

No secrets were ever committed to this repo (gitleaks scan of full history: no leaks). I added gitleaks as a pre-commit hook and in GitHub Actions anyway, after a password leak in my other project, Focus Tracker. The hook uses `pass_filenames: false` because the default `gitleaks-system` hook silently scanned nothing (details in Focus Tracker's BUGS.md).