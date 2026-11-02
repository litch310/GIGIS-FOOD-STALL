<?php
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/connect.php';
require_once __DIR__ . '/email.php';

ini_set('session.use_strict_mode', '1');
$cookieSecure = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
    || getenv('APP_COOKIE_SECURE') === '1';
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $cookieSecure,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

const ORDER_TYPES    = ['dine-in', 'take-out', 'delivery'];
const ORDER_STATUSES = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
const ORDER_TRANSITIONS = [
    'pending' => ['preparing', 'cancelled'],
    'preparing' => ['ready', 'cancelled'],
    'ready' => ['completed', 'cancelled'],
    'completed' => [],
    'cancelled' => [],
];
const UPLOAD_DIR     = 'IMAGES/menu/';
const MAX_UPLOAD     = 3 * 1024 * 1024;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function respond(array $data)
{
    global $con;
    echo json_encode(['success' => true] + $data);
    if ($con) $con->close();
    exit;
}

function fail(string $message, int $status = 400, ?string $code = null)
{
    global $con;
    http_response_code($status);
    $response = ['success' => false, 'message' => $message];
    if ($code !== null) $response['code'] = $code;
    echo json_encode($response);
    if ($con) $con->close();
    exit;
}

// Runs a prepared statement; returns rows for SELECTs, affected rows otherwise.
function query(string $sql, string $types = '', array $params = [])
{
    global $con;
    $stmt = $con->prepare($sql);
    if (!$stmt) {
        error_log('ADBMS database prepare failed: ' . $con->error);
        fail('A database error occurred.', 500);
    }
    if ($types !== '') $stmt->bind_param($types, ...$params);
    if (!$stmt->execute()) {
        $error = $stmt->error;
        $errno = $stmt->errno;
        $stmt->close();
        throw new RuntimeException($error, $errno);
    }
    $res = $stmt->get_result();
    $out = $res ? $res->fetch_all(MYSQLI_ASSOC) : $stmt->affected_rows;
    $stmt->close();
    return $out;
}

function publicUser(array $row)
{
    return [
        'user_id'   => (int)$row['user_id'],
        'full_name' => $row['full_name'],
        'email'     => $row['email'],
        'phone'     => $row['phone'],
        'role'      => $row['role'],
        'status'    => $row['status'],
    ];
}

// The signed-in user, re-read from the database so an approval or
// suspension by the owner applies without signing out.
function currentUser()
{
    if (empty($_SESSION['user'])) return null;
    $rows = query("SELECT * FROM users WHERE user_id = ?", 'i', [$_SESSION['user']['user_id']]);
    if (!$rows || $rows[0]['status'] === 'suspended') {
        unset($_SESSION['user']);
        return null;
    }
    $_SESSION['user'] = publicUser($rows[0]);
    return $_SESSION['user'];
}

// $roles: one role or a list of allowed roles
function requireRole($roles)
{
    $user = currentUser();
    if (!$user) fail('Please sign in first.', 401);
    if (!in_array($user['role'], (array)$roles, true)) fail('You do not have access to that.', 403);
    return $user;
}

// The owner and approved vendors can change the menu
function requireMenuEditor()
{
    $user = requireRole(['owner', 'vendor']);
    if ($user['status'] !== 'active') fail('Your vendor account is waiting for the owner\'s approval.', 403);
    return $user;
}

function requirePost()
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('POST required.', 405);
    $token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $token)) {
        fail('Your session expired. Please refresh the page.', 419);
    }
}

function input(string $key, $default = '')
{
    return isset($_POST[$key]) ? trim((string)$_POST[$key]) : $default;
}

function sessionPayload()
{
    return ['user' => currentUser(), 'csrf' => $_SESSION['csrf']];
}

function castOrder(array $o)
{
    $o['order_id']     = (int)$o['order_id'];
    $o['customer_id']  = (int)$o['customer_id'];
    $o['item_count']   = (int)$o['item_count'];
    $o['total_amount'] = (float)$o['total_amount'];
    return $o;
}

function castProduct(array $p)
{
    $p['product_id']   = (int)$p['product_id'];
    $p['category_id']  = (int)$p['category_id'];
    $p['price']        = (float)$p['price'];
    $p['is_available'] = (bool)$p['is_available'];
    $p['total_sold']   = isset($p['total_sold']) ? (int)$p['total_sold'] : 0;
    return $p;
}

// Shared SELECT for dish lists; $where filters products p.
function productRows(string $where = '1 = 1')
{
    return array_map('castProduct', query("
        SELECT p.product_id, p.category_id, c.name AS category_name, p.name, p.description,
               p.unit, p.price, p.image, p.is_available, p.updated_at,
               cb.full_name AS created_by_name, ub.full_name AS updated_by_name,
               COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN oi.quantity END), 0) AS total_sold
        FROM products p
        JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN users cb ON cb.user_id = p.created_by
        LEFT JOIN users ub ON ub.user_id = p.updated_by
        LEFT JOIN order_items oi ON oi.product_id = p.product_id
        LEFT JOIN orders o ON o.order_id = oi.order_id
        WHERE p.is_archived = 0 AND $where
        GROUP BY p.product_id, p.category_id, c.name, p.name, p.description, p.unit, p.price, p.image,
                 p.is_available, p.updated_at, cb.full_name, ub.full_name, c.sort_order
        ORDER BY c.sort_order, p.price, p.name
    "));
}

function activeProduct(int $productId)
{
    $rows = query("SELECT product_id, name FROM products WHERE product_id = ? AND is_archived = 0", 'i', [$productId]);
    if (!$rows) fail('Dish not found.', 404);
    return $rows[0];
}

// Saves an uploaded product photo and returns its path, or null if none was sent.
function saveUploadedImage(string $productName)
{
    if (empty($_FILES['image']) || $_FILES['image']['error'] === UPLOAD_ERR_NO_FILE) return null;
    $file = $_FILES['image'];
    if ($file['error'] !== UPLOAD_ERR_OK) fail('Photo upload failed. Please try again.');
    if ($file['size'] > MAX_UPLOAD) fail('Photo must be 3 MB or smaller.');

    $info = @getimagesize($file['tmp_name']);
    $extensions = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    if (!$info || !isset($extensions[$info['mime']])) fail('Photo must be a JPG, PNG or WEBP image.');

    $slug = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($productName)), '-');
    $path = UPLOAD_DIR . ($slug ?: 'item') . '-' . time() . '.' . $extensions[$info['mime']];
    if (!move_uploaded_file($file['tmp_name'], __DIR__ . '/' . $path)) fail('Could not save the photo.', 500);
    return $path;
}

// Deletes a photo saved by saveUploadedImage once no dish uses it.
// Seed images (no timestamp in the name) are kept for re-imports of the SQL file.
function deleteUploadedImage(?string $path)
{
    if (!$path || !preg_match('#^' . preg_quote(UPLOAD_DIR, '#') . '[a-z0-9-]+-\d+\.(jpg|png|webp)$#', $path)) return;
    if (query("SELECT 1 FROM products WHERE image = ? LIMIT 1", 's', [$path])) return;
    $file = __DIR__ . '/' . $path;
    if (is_file($file)) @unlink($file);
}

if (!$con) {
    fail('Database connection failed. Please make sure MySQL is running.', 500);
}

if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

try {
    require __DIR__ . '/api/auth.php';
    require __DIR__ . '/api/catalog.php';
    require __DIR__ . '/api/orders.php';
    require __DIR__ . '/api/menu_admin.php';
    require __DIR__ . '/api/owner.php';
    fail('Unknown API action.', 404);

} catch (RuntimeException $e) {
    error_log('ADBMS database query failed: ' . $e->getMessage());
    fail('A database error occurred.', 500);
}
