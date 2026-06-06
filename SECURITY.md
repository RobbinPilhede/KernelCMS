# Security Policy

KernelCMS handles authentication, access control, and uploads, so we take security
reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and steps to reproduce.

We aim to acknowledge reports within a few days and to ship a fix or mitigation as
quickly as the severity warrants. Once a fix is released, we are happy to credit you
unless you prefer to stay anonymous.

## Supported versions

KernelCMS is pre-1.0 and moving fast. Security fixes target the latest `main` and the
most recent published release.

## Hardening checklist for operators

- Set a strong `KERNEL_SECRET` in every non-local environment.
- Use an explicit CORS origin allow-list rather than a wildcard with credentials.
- Put auth endpoints behind your platform's rate limiting in addition to the built-in
  brute-force protection.
- Keep collections secure by default: only opt specific collections into public reads.
- Store provider secrets (S3 or R2, email, OAuth) in your platform's secret manager,
  never in the repository.
