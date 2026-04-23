# Contributing

Thanks for helping improve the OpenClaw OTel Observability Plugin. This document covers the parts of the workflow that are specific to this repo. General Git/GitHub etiquette applies otherwise.

## Branching model

This project uses a two-track support model. Before you start, please read [`SUPPORT.md`](SUPPORT.md).

| Track   | Branch            | OpenClaw range      | Accepts                                                     |
| ------- | ----------------- | ------------------- | ----------------------------------------------------------- |
| `0.2.x` | `main`            | `>= 2026.4.21`      | Features, new attributes, new hooks, refactors, bug fixes.  |
| `0.1.x` | `release/0.1.x`   | `< 2026.4.21`       | Security fixes and critical regressions **only**, cherry-picked from `main`. |

All day-to-day work targets `main`.

## PR labels

Every PR MUST carry exactly one `track/*` label so triage and release notes are unambiguous:

- **`track/0.2`** — PRs targeting `main` (the default).
- **`track/0.1`** — PRs targeting `release/0.1.x` (cherry-picks only).

If you forget the label, a maintainer will add it before merge.

## Backports to `release/0.1.x`

The `release/0.1.x` branch is in **maintenance** through **2026-10-21**. It accepts security fixes and critical regressions that apply to OpenClaw `< 2026.4.21`.

The discipline is strict to keep the branch stable:

1. **Fix on `main` first.** Open a normal PR against `main` and get it merged. Label it `track/0.2`.
2. **Decide whether it backports.** A change qualifies for backport if **all** of the following hold:
   - It is a security fix or a critical regression (not a feature, not a cleanup).
   - It applies to OpenClaw `< 2026.4.21` (i.e., the bug reproduces on `0.1.x`).
   - It does not depend on hooks or APIs that only exist in OpenClaw `>= 2026.4.21`.
3. **Cherry-pick to `release/0.1.x`.** Do **not** merge `main` into `release/0.1.x`; cherry-pick the specific commit(s) instead. From a clean checkout:
   ```bash
   git fetch origin
   git checkout -b backport/<short-desc>-0.1.x origin/release/0.1.x
   git cherry-pick -x <merge-commit-sha-or-range>
   # resolve conflicts if any, keep the change minimal
   git push -u origin backport/<short-desc>-0.1.x
   ```
   The `-x` flag adds a `(cherry picked from commit …)` trailer so the backport is traceable back to `main`.
4. **Open a PR targeting `release/0.1.x`.**
   - Base branch: `release/0.1.x` (not `main`).
   - Label the PR **`track/0.1`**.
   - In the description, link the original `main` PR and note why it qualifies under the backport rules above.
5. **Do not land new work on `release/0.1.x` directly.** Cherry-picks only. If something on `0.1.x` cannot be expressed as a cherry-pick from `main`, open a `track/0.2` discussion issue first so we can decide how to handle it (usually: fix it on `main` in a form that backports cleanly).

### After EOL (2026-10-21)

Once the `release/0.1.x` window closes:

- No further cherry-picks are accepted.
- The branch is archived (not deleted) so consumers can still fetch it.
- Open bug reports on `track/0.1` will be closed with a pointer to upgrade OpenClaw to `>= 2026.4.21` and the plugin to `0.2.x`.

The maintainers may accelerate or extend this date; watch [`SUPPORT.md`](SUPPORT.md) for the authoritative window.

## Development

- Run `npm test` before opening a PR.
- Keep CHANGELOG entries under `[Unreleased]` until a release is cut; move them to a versioned section at release time.
- If a change affects the plugin↔OpenClaw compatibility surface, update `openclaw.plugin.json` (`minOpenClawVersion`), [`CHANGELOG.md`](CHANGELOG.md), and [`SUPPORT.md`](SUPPORT.md) in the same PR.
