---
'kernelcms': minor
---

Atomicity, a published stability policy, and a leaner install.

- **Atomic multi-write.** A document's row write, version snapshot, and content credential now commit in a single transaction — a crash mid-publish can no longer leave a published document without its snapshot or credential. `publishRelease` is now genuinely all-or-nothing (a mid-publish failure rolls the whole release back), and `mergeBranch` / `syncContent` gain an opt-in `atomic` mode. Cascade deletes settle their referrers in one transaction. Adapters without transaction support fall back to the previous best-effort behaviour.
- **Lighter install (action may be required).** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `pg`, and `graphql` are now **optional peer dependencies** instead of hard dependencies, so a SQLite + local-file + REST install no longer pulls ~10 MB of unused packages. Install the one you use: `pg` for the Postgres adapter, the two `@aws-sdk/*` packages for the S3/R2 storage adapter, `graphql` for the GraphQL endpoint. The S3 adapter and GraphQL endpoint load their dependency lazily and surface a clear "install this package" error if it is missing.
- **Stability & versioning policy.** New `STABILITY.md` defines the public API surface, the experimental tiers, the deprecation policy, and the road to 1.0.
