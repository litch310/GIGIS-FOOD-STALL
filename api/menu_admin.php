<?php
// Menu management: the owner and approved vendors share one menu
// ------------------------------------------------------------
if ($action === 'manage_products') {
    requireRole(['owner', 'vendor']);
    respond(['products' => productRows()]);
}

if ($action === 'save_product') {
    requirePost();
    $user = requireMenuEditor();

    $productId   = (int)input('product_id', '0');
    $name        = input('name');
    $categoryId  = (int)input('category_id');
    $description = input('description');
    $unit        = input('unit', '1 serving');
    $price       = input('price');
    $available   = input('is_available', '1') === '1' ? 1 : 0;

    if ($name === '' || mb_strlen($name) > 100) fail('Please enter a dish name.');
    if (!is_numeric($price) || (float)$price < 0 || (float)$price > 99999) fail('Please enter a valid price.');
    if ($unit === '' || mb_strlen($unit) > 30) fail('Please enter a unit, e.g. "1 piece".');
    if (mb_strlen($description) > 255) fail('Description must be 255 characters or fewer.');
    if (!query("SELECT 1 FROM categories WHERE category_id = ?", 'i', [$categoryId])) fail('Please choose a category.');

    $isNew = $productId === 0;
    if (!$isNew) {
        activeProduct($productId);
    } else {
        // Adding back a dish that was removed earlier restores the old record
        $archived = query("SELECT product_id FROM products WHERE name = ? AND is_archived = 1", 's', [$name]);
        if ($archived) $productId = (int)$archived[0]['product_id'];
    }

    $oldImage = null;
    if ($productId > 0) {
        $oldImage = query("SELECT image FROM products WHERE product_id = ?", 'i', [$productId])[0]['image'];
    }

    $image = saveUploadedImage($name);

    try {
        if ($productId > 0) {
            $sql = "UPDATE products SET name = ?, category_id = ?, description = ?, unit = ?, price = ?,
                           is_available = ?, is_archived = 0, updated_by = ?" . ($image ? ", image = ?" : "") . "
                    WHERE product_id = ?";
            $params = [$name, $categoryId, $description ?: null, $unit, (float)$price, $available, $user['user_id']];
            if ($image) $params[] = $image;
            $params[] = $productId;
            query($sql, 'sissdii' . ($image ? 's' : '') . 'i', $params);
        } else {
            query(
                "INSERT INTO products (name, category_id, description, unit, price, is_available, image, created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                'sissdisii',
                [$name, $categoryId, $description ?: null, $unit, (float)$price, $available, $image, $user['user_id'], $user['user_id']]
            );
        }
    } catch (RuntimeException $e) {
        deleteUploadedImage($image);
        if ($e->getCode() === 1062) fail('There is already a dish with that name on the menu.');
        throw $e;
    }
    if ($image) deleteUploadedImage($oldImage);

    respond(['message' => $isNew ? $name . ' was added to the menu.' : $name . ' was updated.']);
}

if ($action === 'toggle_product') {
    requirePost();
    $user = requireMenuEditor();
    $product = activeProduct((int)input('product_id'));
    query(
        "UPDATE products SET is_available = 1 - is_available, updated_by = ? WHERE product_id = ?",
        'ii',
        [$user['user_id'], (int)$product['product_id']]
    );
    respond(['message' => 'Availability updated.']);
}

if ($action === 'delete_product') {
    requirePost();
    $user = requireMenuEditor();
    $product = activeProduct((int)input('product_id'));
    $id = (int)$product['product_id'];
    $image = query("SELECT image FROM products WHERE product_id = ?", 'i', [$id])[0]['image'];

    // Dishes that were never ordered are deleted; ordered dishes are archived
    // so fk_order_items_product keeps past orders intact.
    if (query("SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1", 'i', [$id])) {
        query("UPDATE products SET is_archived = 1, is_available = 0, updated_by = ? WHERE product_id = ?", 'ii', [$user['user_id'], $id]);
    } else {
        query("DELETE FROM products WHERE product_id = ?", 'i', [$id]);
        deleteUploadedImage($image);
    }
    respond(['message' => $product['name'] . ' was removed from the menu.']);
}

// ------------------------------------------------------------
