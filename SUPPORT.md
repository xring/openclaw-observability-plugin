# Support Policy

This project follows a **two-track support model** aligned to OpenClaw Gateway versions and to the plugin hook API surface that each OpenClaw line exposes.

OpenClaw `2026.4.21` introduced the new `before_model_resolve` and `before_prompt_build` plugin hooks, and emits a deprecation warning for the older `before_agent_start` hook. The plugin tracks this split directly.

## Policy

| Track    | OpenClaw range         | Branch           | Status                                                   | Support window                                  |
| -------- | ---------------------- | ---------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `0.1.x`  | `< 2026.4.21`          | `release/0.1.x`  | **Maintenance** — security + critical regressions only    | **Through 2026-10-21** (6 months from 2026.4.21) |
| `0.2.x`  | `>= 2026.4.21`         | `main`           | **Active** — features, new attributes, new hooks          | Default going forward                           |

After **2026-10-21**, the `release/0.1.x` branch is archived unless the maintainers explicitly accelerate or extend the window (for example, because OpenClaw removes `before_agent_start` earlier than planned).

## What "maintenance" means for `0.1.x`

- **Accepted**: security fixes, critical regressions that break basic plugin operation on supported OpenClaw < `2026.4.21` versions.
- **Not accepted**: new features, new telemetry attributes, new hooks, refactors, cosmetic changes.
- **Cherry-picks only**: fixes land on `main` first and are cherry-picked to `release/0.1.x`. See the backport section in [`CONTRIBUTING.md`](CONTRIBUTING.md#backports-to-release01x) for the discipline.
- **PRs must be labeled `track/0.1`**.

## What "active" means for `0.2.x`

- Runs against **OpenClaw `>= 2026.4.21`**, targeting `before_model_resolve` and `before_prompt_build`.
- All new work (features, attributes, hook migrations, documentation) lands on `main`.
- **PRs must be labeled `track/0.2`**.

## Reporting issues

Open a GitHub issue and apply the track label that matches the OpenClaw version you are running:

- OpenClaw **`< 2026.4.21`** → label the issue `track/0.1`.
- OpenClaw **`>= 2026.4.21`** → label the issue `track/0.2`.

If you are not sure which track applies, open the issue and the maintainers will triage it. For `track/0.1` bug reports after the 2026-10-21 EOL date, we recommend upgrading OpenClaw to `>= 2026.4.21` and the plugin to `0.2.x`.

## Escalation

For a regression that blocks production on `0.1.x` before the EOL date, open a `track/0.1` issue with:

- OpenClaw version (`openclaw --version`).
- Plugin version (from `openclaw.plugin.json` → `version`).
- Minimal reproduction and the observed vs expected behavior.

The maintainers review `track/0.1` issues on a best-effort basis through **2026-10-21**.

## Related

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — backport workflow and PR labeling.
- [`CHANGELOG.md`](CHANGELOG.md) — per-release compatibility notes.
