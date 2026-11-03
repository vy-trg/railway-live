## Secret scanning

No secrets were ever committed to this repo (gitleaks scan of full history: no leaks). I added gitleaks as a pre-commit hook and in GitHub Actions anyway, after a password leak in my other project, Focus Tracker. The hook uses `pass_filenames: false` because the default `gitleaks-system` hook silently scanned nothing (details in Focus Tracker's BUGS.md).