<?php
// Session & accounts
// ------------------------------------------------------------
if ($action === 'me') {
    respond(sessionPayload());
}

if ($action === 'login') {
    requirePost();
    $email = strtolower(input('email'));
    throttle('login', $email, 5, 20, 15);
    $rows = query("
        SELECT u.*, av.user_id AS verification_user_id, av.verified_at
        FROM users u
        LEFT JOIN account_verifications av ON av.user_id = u.user_id
        WHERE u.email = ?
    ", 's', [$email]);
    if (!$rows) {
        purgeExpiredPendingAccounts();
        $pending = query(
            "SELECT password_hash FROM pending_accounts WHERE email = ? AND expires_at > UTC_TIMESTAMP() AND status <> 'suspended' LIMIT 1",
            's',
            [$email]
        );
        if ($pending && password_verify(input('password'), $pending[0]['password_hash'])) {
            fail('Please verify your email before signing in.', 403, 'email_unverified');
        }
        recordAttempt('login', $email);
        fail('Wrong email or password.', 401);
    }
    if (!password_verify(input('password'), $rows[0]['password_hash'])) {
        recordAttempt('login', $email);
        fail('Wrong email or password.', 401);
    }
    query("DELETE FROM auth_attempts WHERE action = 'login' AND email = ?", 's', [$email]);
    if ($rows[0]['status'] === 'suspended') fail('This account has been suspended. Please talk to the canteen owner.', 403);
    if (!empty($rows[0]['verification_user_id']) && $rows[0]['verified_at'] === null) {
        fail('Please verify your email before signing in.', 403, 'email_unverified');
    }
    session_regenerate_id(true);
    $_SESSION['user'] = publicUser($rows[0]);
    respond(sessionPayload());
}

if ($action === 'register') {
    requirePost();
    $accountType = input('account_type', 'customer');
    $name        = input('full_name');
    $email       = strtolower(input('email'));
    $phone       = input('phone');
    $password    = input('password');

    // Owner accounts are never self-registered
    if (!in_array($accountType, ['customer', 'vendor'], true)) fail('Please choose an account type.');
    if ($name === '' || mb_strlen($name) > 100) fail('Please enter your name.');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Please enter a valid email.');
    if ($phone !== '' && !preg_match('/^[0-9+\- ]{7,20}$/', $phone)) fail('Please enter a valid phone number.');
    if ($accountType === 'vendor' && $phone === '') fail('Vendors need a contact number so the owner can reach you.');
    if (
        mb_strlen($password, 'UTF-8') < 8
        || !preg_match('/[a-z]/', $password)
        || !preg_match('/[A-Z]/', $password)
        || !preg_match('/[0-9]/', $password)
        || !preg_match('/[^A-Za-z0-9\s]/', $password)
    ) {
        fail('Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number and a special character.');
    }

    throttle('register', $email, 3, 5, 60);
    recordAttempt('register', $email);

    // Vendors can change the menu, so the owner approves them first.
    $status = $accountType === 'vendor' ? 'pending' : 'active';
    purgeExpiredPendingAccounts();

    $existingUsers = query("SELECT user_id FROM users WHERE email = ? LIMIT 1", 's', [$email]);
    if ($existingUsers) fail('That email already has an account.');
    $existingPending = query("SELECT pending_id FROM pending_accounts WHERE email = ? LIMIT 1", 's', [$email]);
    if ($existingPending) {
        fail('A registration for this email is waiting for verification. Use the verification screen to resend its link.', 409, 'verification_pending');
    }

    $con->begin_transaction();
    try {
        $expiresAt = gmdate('Y-m-d H:i:s', time() + 24 * 60 * 60);
        query(
            "INSERT INTO pending_accounts (full_name, email, phone, password_hash, role, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())",
            'sssssss',
            [$name, $email, $phone !== '' ? $phone : null, password_hash($password, PASSWORD_DEFAULT), $accountType, $status, $expiresAt]
        );
        $pendingId = (int)$con->insert_id;
        $con->commit();
    } catch (RuntimeException $e) {
        $con->rollback();
        if ($e->getCode() === 1062) fail('That email already has an account or a registration waiting for verification.');
        throw $e;
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }

    try {
        $token = createPendingAccountToken($pendingId, 1440);
        if ($token === null) {
            fail('Your registration is waiting for verification, but an email could not be started. Request another email from the verification screen.', 503, 'verification_pending');
        }
        sendVerificationEmail($email, $name, $token);
    } catch (EmailDeliveryException $e) {
        fail('Your registration is saved temporarily, but the verification email could not be sent. ' . $e->getMessage() . ' Please try again from the verification screen.', 503, 'verification_pending');
    }
    respond(['message' => 'Registration started. Check your email for a verification link. Your account will be created after you verify.', 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'verify-email') {
    requirePost();
    $token = input('token');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) fail('This verification link is invalid or has expired.', 400);

    purgeExpiredPendingAccounts();
    $con->begin_transaction();
    $rows = query("
        SELECT t.token_id, p.pending_id, p.full_name, p.email, p.phone,
               p.password_hash, p.role, p.status
        FROM pending_account_tokens t
        JOIN pending_accounts p ON p.pending_id = t.pending_id
        WHERE t.token_hash = ? AND t.expires_at > UTC_TIMESTAMP()
          AND p.expires_at > UTC_TIMESTAMP() AND p.status <> 'suspended'
        FOR UPDATE
    ", 's', [hash('sha256', $token)]);
    if (!$rows) {
        $con->rollback();
        fail('This verification link is invalid or has expired.', 400);
    }
    try {
        $existingUsers = query("SELECT user_id FROM users WHERE email = ? LIMIT 1 FOR UPDATE", 's', [$rows[0]['email']]);
        if ($existingUsers) {
            $con->rollback();
            fail('An account already exists for this email. Please sign in.', 409);
        }
        query(
            "INSERT INTO users (full_name, email, phone, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)",
            'ssssss',
            [$rows[0]['full_name'], $rows[0]['email'], $rows[0]['phone'], $rows[0]['password_hash'], $rows[0]['role'], $rows[0]['status']]
        );
        $userId = (int)$con->insert_id;
        query("INSERT INTO account_verifications (user_id, verified_at) VALUES (?, UTC_TIMESTAMP())", 'i', [$userId]);
        query("DELETE FROM pending_accounts WHERE pending_id = ?", 'i', [(int)$rows[0]['pending_id']]);
        $con->commit();
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }
    respond(['message' => 'Email verified. Your account is ready; you can now sign in.', 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'resend-verification') {
    requirePost();
    $email = strtolower(input('email'));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Please enter a valid email address.');
    throttle('resend-verification', $email, 3, 10, 60);
    recordAttempt('resend-verification', $email);

    purgeExpiredPendingAccounts();
    $rows = query("
        SELECT pending_id, full_name
        FROM pending_accounts
        WHERE email = ? AND expires_at > UTC_TIMESTAMP() AND status <> 'suspended'
    ", 's', [$email]);
    if ($rows) {
        try {
            $token = createPendingAccountToken((int)$rows[0]['pending_id'], 1440);
            if ($token !== null) sendVerificationEmail($email, $rows[0]['full_name'], $token);
        } catch (EmailDeliveryException $e) {
            fail('The verification email could not be sent. ' . $e->getMessage(), 503);
        }
    }
    respond(['message' => 'If a registration is waiting for verification at this address, check your inbox for a link. If you requested one in the past minute, wait a minute before trying again. Unverified registrations expire after 24 hours.', 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'forgot-password') {
    requirePost();
    $email = strtolower(input('email'));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Please enter a valid email address.');
    throttle('forgot-password', $email, 3, 10, 60);
    recordAttempt('forgot-password', $email);

    $rows = query("
        SELECT u.user_id, u.full_name
        FROM users u
        WHERE u.email = ? AND u.status <> 'suspended'
    ", 's', [$email]);
    if ($rows) {
        try {
            $token = createAccountToken((int)$rows[0]['user_id'], 'reset', 60);
            if ($token !== null) sendPasswordResetEmail($email, $rows[0]['full_name'], $token);
        } catch (EmailDeliveryException $e) {
            fail('The password reset email could not be sent. ' . $e->getMessage(), 503);
        }
    }
    respond(['message' => 'If an eligible account uses this address, check your inbox for a password reset link. If you requested one in the past minute, wait a minute before trying again.', 'csrf' => $_SESSION['csrf']]);
}

if ($action === 'reset-password') {
    requirePost();
    $token = input('token');
    $password = input('password');
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) fail('This password reset link is invalid or has expired.', 400);
    validateAccountPassword($password);

    $con->begin_transaction();
    $rows = query("
        SELECT t.token_id, t.user_id, u.email,
               av.user_id AS verification_user_id, av.verified_at
        FROM account_tokens t
        JOIN users u ON u.user_id = t.user_id
        LEFT JOIN account_verifications av ON av.user_id = u.user_id
        WHERE t.token_hash = ? AND t.purpose = 'reset' AND t.expires_at > UTC_TIMESTAMP()
        FOR UPDATE
    ", 's', [hash('sha256', $token)]);
    if (!$rows) {
        $con->rollback();
        fail('This password reset link is invalid or has expired.', 400);
    }
    try {
        query("UPDATE users SET password_hash = ? WHERE user_id = ?", 'si', [password_hash($password, PASSWORD_DEFAULT), (int)$rows[0]['user_id']]);
        query("DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'reset'", 'i', [(int)$rows[0]['user_id']]);
        $con->commit();
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }
    $_SESSION = [];
    session_regenerate_id(true);
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    $verificationRequired = !empty($rows[0]['verification_user_id']) && $rows[0]['verified_at'] === null;
    respond([
        'message' => $verificationRequired
            ? 'Password updated. Verify your email before signing in.'
            : 'Password updated. You can now sign in.',
        'verification_required' => $verificationRequired,
        'email' => $verificationRequired ? $rows[0]['email'] : null,
        'csrf' => $_SESSION['csrf'],
    ]);
}

if ($action === 'logout') {
    requirePost();
    $_SESSION = [];
    session_regenerate_id(true);
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    respond(sessionPayload());
}

// ------------------------------------------------------------

function validateAccountPassword(string $password): void
{
    if (
        mb_strlen($password, 'UTF-8') < 8
        || !preg_match('/[a-z]/', $password)
        || !preg_match('/[A-Z]/', $password)
        || !preg_match('/[0-9]/', $password)
        || !preg_match('/[^A-Za-z0-9\s]/', $password)
    ) {
        fail('Password must be at least 8 characters and include a lowercase letter, an uppercase letter, a number and a special character.');
    }
}

// Stops a request once this IP address or email has made too many
// $action attempts in the last $minutes minutes.
function throttle(string $action, string $email, int $perEmail, int $perIp, int $minutes): void
{
    query("DELETE FROM auth_attempts WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)");
    $counts = query("
        SELECT COALESCE(SUM(ip_address = ?), 0) AS by_ip, COALESCE(SUM(email = ?), 0) AS by_email
        FROM auth_attempts
        WHERE action = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
          AND (ip_address = ? OR email = ?)
    ", 'sssiss', [clientIp(), $email, $action, $minutes, clientIp(), $email]);
    if ((int)$counts[0]['by_ip'] >= $perIp || (int)$counts[0]['by_email'] >= $perEmail) {
        fail("Too many attempts. Please wait {$minutes} minutes and try again.", 429, 'rate_limited');
    }
}

function recordAttempt(string $action, string $email): void
{
    query(
        "INSERT INTO auth_attempts (action, ip_address, email, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())",
        'sss',
        [$action, clientIp(), mb_substr($email, 0, 150)]
    );
}

function clientIp(): string
{
    return isset($_SERVER['REMOTE_ADDR']) ? (string)$_SERVER['REMOTE_ADDR'] : '';
}

function purgeExpiredPendingAccounts(): void
{
    query("DELETE FROM pending_accounts WHERE expires_at <= UTC_TIMESTAMP()");
}

function createPendingAccountToken(int $pendingId, int $validMinutes): ?string
{
    global $con;
    $pending = query(
        "SELECT pending_id FROM pending_accounts WHERE pending_id = ? AND status <> 'suspended' AND expires_at > UTC_TIMESTAMP()",
        'i',
        [$pendingId]
    );
    if (!$pending) return null;

    $recent = query(
        "SELECT token_id FROM pending_account_tokens WHERE pending_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)",
        'i',
        [$pendingId]
    );
    if ($recent) return null;

    $token = bin2hex(random_bytes(32));
    $expiresAt = gmdate('Y-m-d H:i:s', time() + $validMinutes * 60);
    $con->begin_transaction();
    try {
        query("DELETE FROM pending_account_tokens WHERE pending_id = ?", 'i', [$pendingId]);
        query(
            "INSERT INTO pending_account_tokens (pending_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())",
            'iss',
            [$pendingId, hash('sha256', $token), $expiresAt]
        );
        query("UPDATE pending_accounts SET expires_at = ? WHERE pending_id = ?", 'si', [$expiresAt, $pendingId]);
        $con->commit();
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }
    return $token;
}

function createAccountToken(int $userId, string $purpose, int $validMinutes): ?string
{
    global $con;
    $recent = query(
        "SELECT token_id FROM account_tokens WHERE user_id = ? AND purpose = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)",
        'is',
        [$userId, $purpose]
    );
    if ($recent) return null;

    $token = bin2hex(random_bytes(32));
    $expiresAt = gmdate('Y-m-d H:i:s', time() + $validMinutes * 60);
    $con->begin_transaction();
    try {
        query("DELETE FROM account_tokens WHERE user_id = ? AND purpose = ?", 'is', [$userId, $purpose]);
        query(
            "INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())",
            'isss',
            [$userId, $purpose, hash('sha256', $token), $expiresAt]
        );
        $con->commit();
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }
    return $token;
}

function sendVerificationEmail(string $email, string $name, string $token): void
{
    $url = appUrl('verify', $token);
    sendAppEmail(
        $email,
        'Verify your Gigi\'s Food House account',
        "Hi {$name},\r\n\r\nVerify your email address to activate your account:\r\n{$url}\r\n\r\nThis link expires in 24 hours. If you did not create an account, you can ignore this email."
    );
}

function sendPasswordResetEmail(string $email, string $name, string $token): void
{
    $url = appUrl('reset', $token);
    sendAppEmail(
        $email,
        'Reset your Gigi\'s Food House password',
        "Hi {$name},\r\n\r\nUse this link to choose a new password:\r\n{$url}\r\n\r\nThis link expires in 1 hour. If you did not request a password reset, you can ignore this email."
    );
}
