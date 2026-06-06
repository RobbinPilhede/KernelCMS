# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a change that should ship in a published package, run:

```bash
pnpm changeset
```

Pick the affected packages and a semver bump (patch / minor / major) and write a short,
user-facing summary. Commit the generated markdown file in this folder with your PR.

On merge to `main`, the Release workflow opens (or updates) a "Version Packages" pull
request that bumps versions and updates changelogs. Merging that PR publishes to npm
(requires an `NPM_TOKEN` repository secret).
