# coven-castles
Sandcastles for sandboxed familiars.

## Secrets protection

Commits are scanned for secrets with [gitleaks](https://github.com/gitleaks/gitleaks). Enable the pre-commit hook once per clone:

```sh
brew install gitleaks   # or see the gitleaks install docs
git config core.hooksPath .githooks
```

The hook blocks any commit whose staged changes contain a likely secret. CI runs the same scan on every push and pull request, so skipping the hook does not skip the check. Handle false positives with an allowlist in `.gitleaks.toml` or a trailing `gitleaks:allow` comment.
