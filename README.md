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
