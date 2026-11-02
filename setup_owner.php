<?php
// One-time owner account bootstrap. Run from the command line only.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/connect.php';

function stopSetup(string $message, int $status = 1): void
{
    fwrite(STDERR, $message . PHP_EOL);
    exit($status);
}

if (!$con) {
    stopSetup('Database connection failed. Check the local .env settings.');
}

$name = trim((string)getenv('OWNER_NAME'));
$email = strtolower(trim((string)getenv('OWNER_EMAIL')));
$password = (string)getenv('OWNER_PASSWORD');
$phone = trim((string)getenv('OWNER_PHONE'));

if ($name === '' || mb_strlen($name) > 100) {
    stopSetup('Set OWNER_NAME to the owner name (up to 100 characters).');
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    stopSetup('Set OWNER_EMAIL to a valid email address.');
}
if (strlen($password) < 12) {
    stopSetup('Set OWNER_PASSWORD to a password with at least 12 characters.');
}
if ($phone !== '' && !preg_match('/^[0-9+\- ]{7,20}$/', $phone)) {
    stopSetup('OWNER_PHONE must be a valid phone number.');
}

$owners = $con->query("SELECT user_id FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1");
if (!$owners) {
    error_log('ADBMS owner bootstrap lookup failed: ' . $con->error);
    stopSetup('Could not check for an existing owner.');
}
if ($owners->num_rows > 0) {
    $owners->free();
    stopSetup('An active owner already exists. This setup command can only run when no active owner is available.', 2);
}
$owners->free();

$hash = password_hash($password, PASSWORD_DEFAULT);
$existing = $con->prepare("SELECT user_id, role, status FROM users WHERE email = ? LIMIT 1");
if (!$existing) {
    error_log('ADBMS owner bootstrap lookup prepare failed: ' . $con->error);
    stopSetup('Could not check the requested email address.');
}
$existing->bind_param('s', $email);
if (!$existing->execute()) {
    error_log('ADBMS owner bootstrap lookup failed: ' . $existing->error);
    $existing->close();
    stopSetup('Could not check the requested email address.');
}
$existingResult = $existing->get_result();
$existingUser = $existingResult ? $existingResult->fetch_assoc() : null;
$existing->close();

if ($existingUser) {
    if ($existingUser['role'] !== 'owner' || $existingUser['status'] !== 'suspended') {
        stopSetup('That email is already in use. Choose a different owner email.');
    }
    $stmt = $con->prepare("UPDATE users SET full_name = ?, phone = ?, password_hash = ?, status = 'active' WHERE user_id = ? AND role = 'owner' AND status = 'suspended'");
} else {
    $stmt = $con->prepare("INSERT INTO users (full_name, email, phone, password_hash, role, status) VALUES (?, ?, ?, ?, 'owner', 'active')");
}
if (!$stmt) {
    error_log('ADBMS owner bootstrap prepare failed: ' . $con->error);
    stopSetup('Could not create the owner account.');
}

$phoneValue = $phone !== '' ? $phone : null;
if ($existingUser) {
    $userId = (int)$existingUser['user_id'];
    $stmt->bind_param('sssi', $name, $phoneValue, $hash, $userId);
} else {
    $stmt->bind_param('ssss', $name, $email, $phoneValue, $hash);
}
if (!$stmt->execute()) {
    error_log('ADBMS owner bootstrap insert failed: ' . $stmt->error);
    $stmt->close();
    stopSetup('Could not create the owner account. Check whether the email is already registered.');
}

$stmt->close();
$con->close();
fwrite(STDOUT, ($existingUser ? 'Suspended owner account restored for ' : 'Owner account created for ') . "{$email}. Remove OWNER_PASSWORD from the environment now.\n");
?>
