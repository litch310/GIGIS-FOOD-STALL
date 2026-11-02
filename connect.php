<?php
// Load a local, untracked .env file when the web server does not provide
// these values through its environment. Process environment takes precedence.
$envFile = __DIR__ . '/.env';
if (is_readable($envFile)) {
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }

        [$key, $value] = explode('=', $line, 2);
        $key = trim($key);
        $value = trim($value);
        if ($key === '' || getenv($key) !== false) {
            continue;
        }

        if (strlen($value) >= 2 && (($value[0] === '"' && substr($value, -1) === '"') || ($value[0] === "'" && substr($value, -1) === "'"))) {
            $value = substr($value, 1, -1);
        }
        putenv($key . '=' . $value);
    }
}

$host = getenv('DB_HOST') ?: '127.0.0.1';
$user = getenv('DB_USER') ?: 'root';
$password = getenv('DB_PASSWORD');
$password = $password === false ? '' : $password;
$dbname = getenv('DB_NAME') ?: 'gigis_food_house';
$portValue = getenv('DB_PORT') ?: '3306';
$port = filter_var($portValue, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]) ?: 3306;

mysqli_report(MYSQLI_REPORT_OFF);
$con = @new mysqli($host, $user, $password, $dbname, $port);

if ($con->connect_errno) {
    error_log('ADBMS database connection failed: ' . $con->connect_error);
    $con = null;
} elseif (!$con->set_charset('utf8mb4')) {
    error_log('ADBMS could not set the database connection charset: ' . $con->error);
    $con->close();
    $con = null;
}
?>
