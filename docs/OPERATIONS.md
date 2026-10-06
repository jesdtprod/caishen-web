# Production Operations

## Backup And Restore

1. In Supabase, create a database backup before every production release and retain a dated export of the critical tables.
2. Record the backup date, release commit, and operator in the release log.
3. Test restoration in a separate Supabase project before relying on a backup for an incident.
4. Never restore into production until the restored inventory, sales totals, and credit balances have been checked.

## Account Recovery

1. Maintain at least two active administrator accounts with separately stored credentials.
2. Use the administrator account screen to deactivate access instead of deleting historical accounts.
3. Staff branch assignment is permanent after account creation. Create a replacement account if a staff member permanently moves branches.
4. Resetting a staff or another administrator password requires that person to choose a new password at the next sign-in.

## Release Procedure

1. Run `node --check app.js` and `node scripts/check-pos.mjs`.
2. Apply all pending SQL files in `supabase/migrations/` to Supabase in filename order.
3. Deploy `supabase/functions/manage-account/index.ts` as the `manage-account` Edge Function with legacy JWT verification disabled.
4. Push the tested commit to `main`, then verify the GitHub Pages application in a fresh browser session.
5. Test administrator login, staff login, one stock-in, one cash sale, one credit payment, and one transfer before announcing the release.

## Migration Automation

When Supabase CLI access is configured for the project, replace manual SQL Editor deployment with:

```powershell
supabase link --project-ref ozpwabhqbxdanayqniyo
supabase db push
supabase functions deploy manage-account --no-verify-jwt
```

Keep the access token outside the repository, such as in a secure local environment variable or CI secret.
