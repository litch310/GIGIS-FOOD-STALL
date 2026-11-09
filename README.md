# Gigi's Food House

## Local setup

1. Copy `.env.example` to `.env` and set `DB_PASSWORD` to the local MySQL password. The `.env` file is ignored by Git.
2. Import `gigis_food_house.sql` into MySQL. **This script drops and recreates the `gigis_food_house` database**, so only import it when creating a fresh local database.
3. Create the first owner from PowerShell. The password prompt below is hidden while you type; the environment values are removed afterward. The owner password must be at least 12 characters. Optional: set `OWNER_PHONE`.

   ```powershell
   $env:OWNER_NAME = 'Gigi'
   $env:OWNER_EMAIL = 'owner@example.com'
   $securePassword = Read-Host 'Owner password' -AsSecureString
   $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
   try {
       $env:OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
       php .\setup_owner.php
   } finally {
       [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
       Remove-Item Env:OWNER_PASSWORD -ErrorAction SilentlyContinue
       Remove-Item Env:OWNER_NAME -ErrorAction SilentlyContinue
       Remove-Item Env:OWNER_EMAIL -ErrorAction SilentlyContinue
   }
   ```

4. Open `index.php` through a PHP web server. Customers can register in the app; vendor registrations wait for owner approval.

Do not commit `.env` or place production credentials in source control. Configure `APP_COOKIE_SECURE=1` when HTTPS is terminated by a proxy that does not pass the HTTPS state through to PHP. Direct HTTPS requests automatically use Secure session cookies.

## Email verification and password reset

New registrations are held in `pending_accounts` for up to 24 hours and are inserted into `users` only after email verification. Expired pending registrations are removed on the next registration, pending-registration sign-in, resend, or verification request. Password reset links expire after 1 hour and can only be used once. Existing verified accounts remain unchanged.

Rate limiting is stored in the `auth_attempts` table: 5 failed sign-ins per email (20 per IP address) every 15 minutes, and a few registration, resend and password reset emails per hour.

After registration, the app opens a waiting-for-verification screen with the resend form. A correct sign-in attempt for a pending registration also returns to this screen. If the registration expires before verification, register again.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, and `APP_BASE_URL` in the ignored local `.env` file or your deployment's secret manager. Gmail SMTP uses `smtp.gmail.com` on port `587` with STARTTLS. Use an app password for `SMTP_PASSWORD`, and set `SMTP_FROM` to an address permitted by that SMTP account. `APP_BASE_URL` must be the public root URL of this app (for example, `https://example.com`); use the actual local web-server URL for development. Never commit SMTP credentials.

The SQL import seeds the menu only. It does not create demo users or orders with shared passwords.

## Deploying to Vercel (Supabase database)

The PHP files above are for local MySQL development. On Vercel the same
frontend (`index.html`, `app.js`, `style.css`) talks to a Node.js port of the
API in [`api/index.js`](./api/index.js), which uses a Supabase (PostgreSQL)
database. Requests to `api.php` are rewritten to it, so `app.js` is unchanged.
[`.vercelignore`](./.vercelignore) keeps the PHP files, SQL scripts and
setup tools out of the deployment.

### 1. Create the database

1. Create a Supabase project.
2. In **SQL Editor**, run [`supabase_schema.sql`](./supabase_schema.sql).
   It creates the tables and seeds the menu. **Re-running it deletes all
   accounts, orders and menu changes.**
   - Already ran an older version of this script? Run
     [`supabase_upgrade.sql`](./supabase_upgrade.sql) instead. It keeps your
     data, adds the new tables, blocks the tables from Supabase's public
     REST API, and suspends the old `admin@gigisfoodhouse.com` account if its
     published default password was never changed.
3. Copy the connection string from **Connect > Connection string**. Use the
   **Transaction pooler** URI (port `6543`); serverless functions open many
   short connections.

### 2. Create the owner account

No account is created by the SQL script. From the project folder, with
Node.js 20 or newer (the password prompt is hidden; the values are removed
afterward; the password must be at least 12 characters):

```powershell
npm install
$env:DATABASE_URL = Read-Host 'Supabase connection string'
$env:OWNER_NAME = 'Gigi'
$env:OWNER_EMAIL = 'owner@example.com'
$securePassword = Read-Host 'Owner password' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $env:OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    npm run create-owner
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    Remove-Item Env:OWNER_PASSWORD, Env:OWNER_NAME, Env:OWNER_EMAIL, Env:DATABASE_URL -ErrorAction SilentlyContinue
}
```

### 3. Import the project in Vercel

Import the GitHub repository in Vercel. Keep the defaults: Framework Preset
**Other**, no build command, root directory `./`. Add these environment
variables (Project Settings > Environment Variables):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase transaction pooler URI from step 1 |
| `DATABASE_CA_CERT` | Recommended. Contents of the certificate from Supabase **Database Settings > SSL Configuration > Download certificate**, so the database's identity is verified. Without it the connection is encrypted but not verified. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Same as for the PHP version (see above) |
| `APP_BASE_URL` | Public URL used in emailed links, for example `https://gigis-food-house.vercel.app`. Defaults to the project's Vercel production domain. |
| `APP_TIMEZONE` | Optional. Time zone for the owner's "today's sales" figure. Default `Asia/Manila`. |

Sign-ups and password resets need the SMTP settings: accounts are only
created after the emailed link is opened.

### How the Vercel version differs from the PHP version

- Sessions are stored in the `sessions` table instead of PHP session files,
  because serverless functions have no shared disk. Sessions end after 12
  idle hours and when the browser closes; resetting a password signs that
  account out everywhere.
- Dish photos uploaded in the menu manager are stored in the
  `product_images` table and served from `api.php?action=image&id=...`.
  Photos uploaded to a local PHP install are not carried over.
- Row level security is enabled on every table with no policies. The API
  connects as the database owner, which bypasses it; Supabase's public REST
  API (anon key) can read nothing.
