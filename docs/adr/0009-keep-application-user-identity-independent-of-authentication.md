# Keep application user identity independent of authentication

The application owns a permanent user ID independent of the authentication provider; organization ownership and tour-access assignments reference that ID. The authentication integration maps a provider's login identity to the application user, allowing a provider replacement to preserve application relationships rather than rebuilding them around new provider identifiers. This requires an explicit identity mapping.

Initial sign-in uses email and password. Email is a sign-in attribute rather than the permanent application identity, and organization ownership and tour-access relationships must not use email addresses as foreign keys.

A provider migration may require users to sign in again and, if necessary, set a new password. Preserve application user IDs, organization ownership, and tour access, without promising portability of existing passwords or active sessions; the specific migration mechanism remains undecided.
