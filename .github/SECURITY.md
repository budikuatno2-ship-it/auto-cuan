# Security Policy

Auto-Cuan handles authenticated user data and privileged administrative workflows. Please do not publish exploit details, credentials, tokens, private data, or proof-of-concept payloads in a public issue.

## Reporting a vulnerability

Use GitHub's private security-advisory / private vulnerability-reporting flow when it is available for this repository. If that option is unavailable, contact the repository owner privately before disclosing technical details.

Include only the minimum information required to reproduce the problem. Redact cookies, Authorization headers, Telegram identifiers, Supabase credentials, Vercel credentials, webhook secrets, and production database data.

## Scope priorities

Highest priority findings include authentication or authorization bypass, session forgery/replay, privilege escalation, secret exposure, Supabase RLS or service-role bypass, Telegram admin-access bypass, arbitrary code execution, server-side request forgery, SQL injection, stored/reflected XSS, and CI/CD supply-chain compromise.

Do not test against production in a way that degrades availability, modifies another user's data, sends unwanted Telegram messages, or triggers trading-related automation.
