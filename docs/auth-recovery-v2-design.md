# Telegram-backed authentication recovery

## Login

- Username and password remain the normal sign-in credentials.
- Browser device IDs are not authentication credentials and no longer decide whether login is allowed.
- A signed HttpOnly server cookie is the only authority for restoring a website session.
- localStorage is UI persistence only and is cleared when the server says the account/session is invalid.

## Password recovery

- The website accepts a username and always returns a generic response.
- Only an account with an existing verified private Telegram binding receives a bot prompt.
- The bot offers `Konfirmasi Reset` and `Tolak`.
- Approval creates a one-time website link valid for ten minutes.
- The new password is entered only on the website and is never sent through Telegram.

## Existing budi account

- A service-role-only VPS command creates a one-time `AR-XXXX-XXXX` enrollment code.
- Sending that code to `AutoCuanVerificationBot` binds the intended Telegram identity to `budi`.
- Enrollment does not change the stored password, approval state, role, or device fields.
- After enrollment, `budi` uses the same Telegram-confirmed password recovery flow.

## Isolation

- The existing verification bot token remains isolated from recommendation bots.
- Existing pending-registration and channel-join verification messages are delegated to the current Telegram verification implementation.
- Recovery-specific webhook events use a separate idempotency table.
