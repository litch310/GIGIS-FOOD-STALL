<?php
// Customer: place order, list own orders, cancel pending order
// ------------------------------------------------------------
if ($action === 'place_order') {
    requirePost();
    $user = requireRole('customer');

    $orderType = input('order_type', 'dine-in');
    $notes     = input('notes');
    $cart      = json_decode(input('cart', '[]'), true);

    if (!in_array($orderType, ORDER_TYPES, true)) fail('Please choose dine-in, take-out or delivery.');
    if (mb_strlen($notes) > 255) fail('Notes must be 255 characters or fewer.');
    if (!is_array($cart) || !$cart) fail('Your tray is empty.');

    // Merge duplicate lines and validate quantities
    $lines = [];
    foreach ($cart as $line) {
        $pid = isset($line['product_id']) ? (int)$line['product_id'] : 0;
        $qty = isset($line['quantity']) ? (int)$line['quantity'] : 0;
        if ($pid <= 0 || $qty <= 0 || $qty > 99) fail('Invalid item quantity in your tray.');
        $lines[$pid] = (isset($lines[$pid]) ? $lines[$pid] : 0) + $qty;
    }

    // Prices always come from the database, never from the browser
    $ids = array_keys($lines);
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $products = query(
        "SELECT product_id, name, price, is_available, is_archived FROM products WHERE product_id IN ($placeholders)",
        str_repeat('i', count($ids)),
        $ids
    );
    if (count($products) !== count($ids)) fail('Some items in your tray are no longer on the menu.');
    foreach ($products as $p) {
        if ($p['is_archived']) fail($p['name'] . ' is no longer on the menu. Please remove it from your tray.');
        if (!$p['is_available']) fail($p['name'] . ' is sold out. Please remove it from your tray.');
    }

    $con->begin_transaction();
    try {
        query(
            "INSERT INTO orders (customer_id, order_type, notes) VALUES (?, ?, ?)",
            'iss',
            [$user['user_id'], $orderType, $notes !== '' ? $notes : null]
        );
        $orderId = $con->insert_id;
        foreach ($products as $p) {
            query(
                "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
                'iiid',
                [$orderId, (int)$p['product_id'], $lines[(int)$p['product_id']], (float)$p['price']]
            );
        }
        $con->commit();
    } catch (Throwable $e) {
        $con->rollback();
        throw $e;
    }

    respond(['order_id' => $orderId, 'message' => "Order #{$orderId} placed!"]);
}

if ($action === 'my_orders') {
    $user = requireRole('customer');
    $orders = array_map('castOrder', query(
        "SELECT * FROM v_order_summary WHERE customer_id = ? ORDER BY created_at DESC",
        'i',
        [$user['user_id']]
    ));
    // Queue position: open orders placed before each of this customer's pending orders
    $queue = query("
        SELECT o.order_id,
               (SELECT COUNT(*) FROM orders a
                WHERE a.status IN ('pending', 'preparing') AND a.order_id < o.order_id) AS orders_ahead
        FROM orders o
        WHERE o.customer_id = ? AND o.status = 'pending'
    ", 'i', [$user['user_id']]);
    $ahead = array_column($queue, 'orders_ahead', 'order_id');

    $spent = 0.0;
    foreach ($orders as &$o) {
        if ($o['status'] !== 'cancelled') $spent += $o['total_amount'];
        if (isset($ahead[$o['order_id']])) $o['orders_ahead'] = (int)$ahead[$o['order_id']];
    }
    unset($o);
    respond(['orders' => $orders, 'total_spent' => $spent]);
}

if ($action === 'vendor_orders') {
    $user = requireRole('vendor');
    if ($user['status'] !== 'active') fail('Your vendor account is waiting for the owner\'s approval.', 403);
    $orders = array_map('castOrder', query("SELECT * FROM v_order_summary ORDER BY created_at DESC"));
    respond(['orders' => $orders]);
}

if ($action === 'cancel_order') {
    requirePost();
    $user = requireRole('customer');
    $affected = query(
        "UPDATE orders SET status = 'cancelled' WHERE order_id = ? AND customer_id = ? AND status = 'pending'",
        'ii',
        [(int)input('order_id'), $user['user_id']]
    );
    if (!$affected) fail('Only pending orders can be cancelled.');
    respond(['message' => 'Order cancelled.']);
}

// ------------------------------------------------------------
// Order line items (owner and active vendor: any order, customer: own orders)
// ------------------------------------------------------------
if ($action === 'order_details') {
    $user = requireRole(['owner', 'vendor', 'customer']);
    if ($user['role'] === 'vendor' && $user['status'] !== 'active') {
        fail('Your vendor account is waiting for the owner\'s approval.', 403);
    }
    $orderId = isset($_GET['order_id']) ? (int)$_GET['order_id'] : 0;

    $orders = query("SELECT * FROM v_order_summary WHERE order_id = ?", 'i', [$orderId]);
    if (!$orders) fail('Order not found.', 404);
    $order = castOrder($orders[0]);
    if ($user['role'] === 'customer' && $order['customer_id'] !== $user['user_id']) fail('Order not found.', 404);

    $items = query("
        SELECT oi.product_id, p.name, p.unit, p.image, oi.quantity, oi.unit_price,
               oi.quantity * oi.unit_price AS subtotal
        FROM order_items oi
        JOIN products p ON p.product_id = oi.product_id
        WHERE oi.order_id = ?
        ORDER BY oi.order_item_id
    ", 'i', [$orderId]);
    foreach ($items as &$i) {
        $i['quantity']   = (int)$i['quantity'];
        $i['unit_price'] = (float)$i['unit_price'];
        $i['subtotal']   = (float)$i['subtotal'];
    }
    unset($i);

    respond(['order' => $order, 'items' => $items]);
}

// ------------------------------------------------------------
