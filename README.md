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

## Deploying to Render (Render Postgres)

The PHP files above are for local MySQL development. On Render,
[`server.js`](./server.js) serves the same frontend (`index.html`, `app.js`,
`style.css`, `IMAGES/menu/`) and sends `api.php` requests to a Node.js port
of the API in [`api/index.js`](./api/index.js), which uses a Render Postgres
database. `app.js` is unchanged. `server.js` serves only those frontend
files, never the PHP sources, SQL scripts or `.env`.

### 1. Create the database and web service

In the Render dashboard choose **New > Blueprint** and pick this repository.
[`render.yaml`](./render.yaml) creates:

- **gigis-food-house-db**, a Postgres database. Its internal connection
  string is passed to the web service as `DATABASE_URL` automatically.
- **gigis-food-house**, the web service (`npm ci`, `npm start`, health check
  `/healthz`), in the same region (Singapore).

Render asks for `SMTP_USERNAME`, `SMTP_PASSWORD` and `SMTP_FROM` (same as
for the PHP version, see above; `SMTP_HOST` and `SMTP_PORT` default to
Gmail). Optional: `APP_BASE_URL` (public URL used in emailed links; defaults
to the service's `onrender.com` address) and `APP_TIMEZONE` (for the owner's
"today's sales"; default `Asia/Manila`).

On its first start against the empty database, the web service creates the
tables and seed menu from [`schema.sql`](./schema.sql). It never changes a
database that already has the tables. (Running `schema.sql` by hand resets
the database and deletes all accounts and orders.)

**Free plan limits:**
- Render deletes a free Postgres database 30 days after it is created
  unless it is upgraded to a paid plan. Upgrade before then to keep the data.
- Free web services block outgoing SMTP (ports 25, 465 and 587), so sign-ups
  and password resets, which need email, only work on a paid instance type.
  Everything else works on the free plan.

### 2. Create the owner account

After the first deploy has created the tables, run this once from the project folder, with
Node.js 20 or newer (the password prompt is hidden; the values are removed
afterward; the password must be at least 12 characters):

```powershell
npm install
$env:DATABASE_URL = Read-Host 'External Database URL'
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

Use the database's **External Database URL** (Render dashboard > the
database > **Connect** > External). Leave `DATABASE_SSL` unset for it; the
connection uses TLS.

### 3. Keep the free instance awake

Render's free plan stops the service after 15 minutes without visitors; the
next visit then waits about a minute while it starts again. The workflow
[`.github/workflows/keep-awake.yml`](./.github/workflows/keep-awake.yml)
loads the menu every 10 minutes. If the service's address is not
`https://gigis-food-stall-i2ut.onrender.com`, set the repository variable
`SITE_URL` (GitHub **Settings > Secrets and variables > Actions >
Variables**). GitHub may delay scheduled runs by a few minutes, and turns
them off after 60 days without commits to the repository.

### How the Render version differs from the PHP version

- Sessions are stored in the `sessions` table instead of PHP session files,
  so they survive restarts and deploys. Sessions end after 12 idle hours and
  when the browser closes; resetting a password signs that account out
  everywhere.
- Dish photos uploaded in the menu manager are stored in the
  `product_images` table and served from `api.php?action=image&id=...`,
  because Render's disk is wiped on every deploy. Photos uploaded to a local
  PHP install are not carried over.

To run the Node version locally against any Postgres: put `DATABASE_URL`
(and `DATABASE_SSL=disable` if it has no TLS) in `.env`, then `npm install`
and `node --env-file=.env server.js`, and open http://localhost:3000.
