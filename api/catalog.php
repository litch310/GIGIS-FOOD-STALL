<?php
// Menu (public). The owner and vendors also see sold-out dishes.
// ------------------------------------------------------------
if ($action === 'menu') {
    $user = currentUser();
    $isStaff = $user && in_array($user['role'], ['owner', 'vendor'], true);

    $categories = query("SELECT category_id, name FROM categories ORDER BY sort_order, name");
    foreach ($categories as &$c) $c['category_id'] = (int)$c['category_id'];
    unset($c);

    $products = productRows($isStaff ? '1 = 1' : 'p.is_available = 1');

    // Top 3 best sellers get a badge
    $sold = array_column($products, 'total_sold', 'product_id');
    arsort($sold);
    $ranks = [];
    foreach (array_slice($sold, 0, 3, true) as $id => $qty) {
        if ($qty > 0) $ranks[$id] = count($ranks) + 1;
    }
    foreach ($products as &$p) $p['rank'] = isset($ranks[$p['product_id']]) ? $ranks[$p['product_id']] : 0;
    unset($p);

    respond(['categories' => $categories, 'products' => $products]);
}

// ------------------------------------------------------------
