<?php
// Owner: dashboard, order status, vendors, customers
// ------------------------------------------------------------
if ($action === 'owner_dashboard') {
    requireRole('owner');

    $orders = array_map('castOrder', query("SELECT * FROM v_order_summary ORDER BY created_at DESC"));
    foreach ($orders as &$order) {
        $order['allowed_statuses'] = array_merge([$order['status']], ORDER_TRANSITIONS[$order['status']]);
    }
    unset($order);

    $kpi = query("
        SELECT
            COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_amount END), 0) AS total_sales,
            COALESCE(SUM(CASE WHEN status <> 'cancelled' AND DATE(created_at) = CURDATE() THEN total_amount END), 0) AS today_sales,
            SUM(status IN ('pending', 'preparing', 'ready')) AS open_orders,
            COUNT(*) AS total_orders
        FROM v_order_summary
    ")[0];

    $top = query("
        SELECT p.name, SUM(oi.quantity) AS qty
        FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id AND o.status <> 'cancelled'
        JOIN products p ON p.product_id = oi.product_id
        GROUP BY p.product_id, p.name
        ORDER BY qty DESC
        LIMIT 1
    ");

    $pendingVendors = query("SELECT COUNT(*) AS n FROM users WHERE role = 'vendor' AND status = 'pending'")[0]['n'];

    respond([
        'orders' => $orders,
        'kpis'   => [
            'total_sales'     => (float)$kpi['total_sales'],
            'today_sales'     => (float)$kpi['today_sales'],
            'open_orders'     => (int)$kpi['open_orders'],
            'total_orders'    => (int)$kpi['total_orders'],
            'top_item'        => $top ? $top[0]['name'] : null,
            'pending_vendors' => (int)$pendingVendors,
        ],
    ]);
}

if ($action === 'update_order_status') {
    requirePost();
    $user = requireRole(['owner', 'vendor']);
    if ($user['role'] === 'vendor' && $user['status'] !== 'active') {
        fail('Your vendor account is waiting for the owner\'s approval.', 403);
    }
    $status = input('status');
    $orderId = (int)input('order_id');
    if (!in_array($status, ORDER_STATUSES, true)) fail('Unknown order status.');
    $orders = query("SELECT status FROM orders WHERE order_id = ?", 'i', [$orderId]);
    if (!$orders) fail('Order not found.', 404);
    $currentStatus = $orders[0]['status'];
    if ($status === $currentStatus) respond(['message' => 'Order status is unchanged.']);
    if ($user['role'] === 'vendor') {
        $vendorTransitions = [
            'pending' => ['preparing'],
            'preparing' => ['completed'],
            'ready' => ['completed'],
        ];
        $allowedTransitions = isset($vendorTransitions[$currentStatus]) ? $vendorTransitions[$currentStatus] : [];
    } else {
        $allowedTransitions = ORDER_TRANSITIONS[$currentStatus];
    }
    if (!in_array($status, $allowedTransitions, true)) {
        fail('That status change is not allowed for this order.', 409);
    }

    $affected = query("UPDATE orders SET status = ? WHERE order_id = ? AND status = ?", 'sis', [$status, $orderId, $currentStatus]);
    if (!$affected) fail('The order changed before this update. Refresh and try again.', 409);
    respond(['message' => 'Order updated.']);
}

if ($action === 'vendors') {
    requireRole('owner');
    $vendors = query("
        SELECT u.user_id, u.full_name, u.email, u.phone, u.status, u.created_at,
               (SELECT COUNT(*) FROM products p WHERE p.created_by = u.user_id) AS dishes_added,
               (SELECT MAX(p.updated_at) FROM products p WHERE p.updated_by = u.user_id) AS last_menu_edit
        FROM users u
        WHERE u.role = 'vendor'
        ORDER BY FIELD(u.status, 'pending', 'active', 'suspended'), u.full_name
    ");
    foreach ($vendors as &$v) {
        $v['user_id']      = (int)$v['user_id'];
        $v['dishes_added'] = (int)$v['dishes_added'];
    }
    unset($v);
    respond(['vendors' => $vendors]);
}

if ($action === 'set_vendor_status') {
    requirePost();
    requireRole('owner');
    $status = input('status');
    $userId = (int)input('user_id');
    if (!in_array($status, ['active', 'suspended'], true)) fail('Unknown account status.');
    if (!query("SELECT 1 FROM users WHERE user_id = ? AND role = 'vendor'", 'i', [$userId])) fail('Vendor not found.', 404);
    query("UPDATE users SET status = ? WHERE user_id = ? AND role = 'vendor'", 'si', [$status, $userId]);
    respond(['message' => 'Vendor account updated.']);
}

if ($action === 'customers') {
    requireRole('owner');
    $customers = query("
        SELECT u.user_id, u.full_name, u.email, u.phone, u.created_at,
               COUNT(s.order_id) AS order_count,
               COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.total_amount END), 0) AS total_spent,
               MAX(s.created_at) AS last_order_at
        FROM users u
        LEFT JOIN v_order_summary s ON s.customer_id = u.user_id
        WHERE u.role = 'customer'
        GROUP BY u.user_id, u.full_name, u.email, u.phone, u.created_at
        ORDER BY total_spent DESC, u.full_name
    ");
    foreach ($customers as &$c) {
        $c['user_id']     = (int)$c['user_id'];
        $c['order_count'] = (int)$c['order_count'];
        $c['total_spent'] = (float)$c['total_spent'];
    }
    unset($c);
    respond(['customers' => $customers]);
}
