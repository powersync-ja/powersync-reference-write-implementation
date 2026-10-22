# How to use PowerSync development tokens for authentication

Development tokens let you try the write API without an auth provider. PowerSync Cloud signs a
token for any user ID you choose, and it expires after 12 hours. They are for local development
and debugging only; use a [real provider](setup.md) in production. They work with the Express
backend. The Supabase Edge Function accepts only Supabase Auth user tokens.

## 1. Generate a token

1. In the PowerSync Dashboard, open the **Client Auth** view, enable **Development tokens** and save.
2. Click **Connect** in the top bar, enter a user ID, click **Generate Token** and copy it.

## 2. Trust the development keys

Development tokens are signed with a PowerSync-hosted key that is published at:

```
https://powersync-api.journeyapps.com/jwks/<instance id>.json
```

Configure the backend in [`AUTH_MODE=env`](setup.md#environment-variables-only) with:

```dotenv
AUTH_MODE=env
AUTH_ISSUER=https://powersync-api.journeyapps.com
AUTH_AUDIENCE=https://<instance id>.powersync.journeyapps.com
AUTH_JWKS_URI=https://powersync-api.journeyapps.com/jwks/<instance id>.json
```

Restart the backend after changing these.

## 3. Use the token

In your copy of the connector, return the token from the private `fetchAuthToken()` method.
Both `fetchCredentials()` (sync) and writes use it.
