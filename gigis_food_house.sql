-- ============================================================
-- Gigi's Food House - canteen ordering database
-- Import in phpMyAdmin (Import tab) or: mysql -u root -p < gigis_food_house.sql
-- Re-running this file resets the database to the menu sample data below.
-- ============================================================

DROP DATABASE IF EXISTS `gigis_food_house`;
CREATE DATABASE `gigis_food_house` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `gigis_food_house`;

-- ------------------------------------------------------------
-- users: the canteen owner, vendors (Gigi's Food House staff who manage
-- the menu) and customers share one login table. New vendor accounts stay
-- 'pending' until the owner approves them.
-- ------------------------------------------------------------
CREATE TABLE `users` (
  `user_id`       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name`     VARCHAR(100) NOT NULL,
  `email`         VARCHAR(150) NOT NULL,
  `phone`         VARCHAR(20)  DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role`          ENUM('owner', 'vendor', 'customer') NOT NULL DEFAULT 'customer',
  `status`        ENUM('active', 'pending', 'suspended') NOT NULL DEFAULT 'active',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- account_verifications: a row exists only for accounts created after
-- email verification is enabled. Older accounts without a row stay usable.
-- ------------------------------------------------------------
CREATE TABLE `account_verifications` (
  `user_id`      INT UNSIGNED NOT NULL,
  `verified_at`  DATETIME DEFAULT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_account_verifications_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- account_tokens: hashed, one-time email verification and reset tokens
-- ------------------------------------------------------------
CREATE TABLE `account_tokens` (
  `token_id`     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`      INT UNSIGNED NOT NULL,
  `purpose`      ENUM('verify', 'reset') NOT NULL,
  `token_hash`   CHAR(64) NOT NULL,
  `expires_at`   DATETIME NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `uq_account_tokens_hash` (`token_hash`),
  KEY `idx_account_tokens_user_purpose` (`user_id`, `purpose`),
  KEY `idx_account_tokens_expiry` (`expires_at`),
  CONSTRAINT `fk_account_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- pending_accounts: registration details are temporary and do not become a
-- user account until the email verification token is redeemed.
CREATE TABLE `pending_accounts` (
  `pending_id`   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name`    VARCHAR(100) NOT NULL,
  `email`        VARCHAR(150) NOT NULL,
  `phone`        VARCHAR(20) DEFAULT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role`         ENUM('owner', 'vendor', 'customer') NOT NULL,
  `status`       ENUM('active', 'pending', 'suspended') NOT NULL DEFAULT 'active',
  `expires_at`   DATETIME NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`pending_id`),
  UNIQUE KEY `uq_pending_accounts_email` (`email`),
  KEY `idx_pending_accounts_expiry` (`expires_at`)
) ENGINE=InnoDB;

CREATE TABLE `pending_account_tokens` (
  `token_id`     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pending_id`   INT UNSIGNED NOT NULL,
  `token_hash`   CHAR(64) NOT NULL,
  `expires_at`   DATETIME NOT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `uq_pending_account_tokens_hash` (`token_hash`),
  KEY `idx_pending_account_tokens_pending` (`pending_id`),
  KEY `idx_pending_account_tokens_expiry` (`expires_at`),
  CONSTRAINT `fk_pending_account_tokens_pending` FOREIGN KEY (`pending_id`) REFERENCES `pending_accounts` (`pending_id`) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- auth_attempts: recent sign-in failures and email requests, used to
-- slow down password guessing and email spam. Rows older than a day are purged.
-- ------------------------------------------------------------
CREATE TABLE `auth_attempts` (
  `attempt_id`  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `action`      VARCHAR(30) NOT NULL,
  `ip_address`  VARCHAR(45) NOT NULL,
  `email`       VARCHAR(150) NOT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`attempt_id`),
  KEY `idx_auth_attempts_ip` (`action`, `ip_address`, `created_at`),
  KEY `idx_auth_attempts_email` (`action`, `email`, `created_at`),
  KEY `idx_auth_attempts_created` (`created_at`)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- categories: sections of the menu board
-- ------------------------------------------------------------
CREATE TABLE `categories` (
  `category_id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(60) NOT NULL,
  `sort_order`  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`category_id`),
  UNIQUE KEY `uq_categories_name` (`name`)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- products: Gigi's Food House dishes, managed by the owner and vendors.
-- Dishes that were ordered before are archived instead of deleted so
-- order history stays intact. created_by / updated_by record who did it.
-- ------------------------------------------------------------
CREATE TABLE `products` (
  `product_id`   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id`  INT UNSIGNED NOT NULL,
  `name`         VARCHAR(100) NOT NULL,
  `description`  VARCHAR(255) DEFAULT NULL,
  `unit`         VARCHAR(30)  NOT NULL DEFAULT '1 serving',
  `price`        DECIMAL(8,2) NOT NULL,
  `image`        VARCHAR(255) DEFAULT NULL,
  `is_available` TINYINT(1)   NOT NULL DEFAULT 1,
  `is_archived`  TINYINT(1)   NOT NULL DEFAULT 0,
  `created_by`   INT UNSIGNED DEFAULT NULL,
  `updated_by`   INT UNSIGNED DEFAULT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_id`),
  UNIQUE KEY `uq_products_name` (`name`),
  KEY `idx_products_category` (`category_id`),
  CONSTRAINT `fk_products_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `fk_products_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`category_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `chk_products_price` CHECK (`price` >= 0)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- orders: one row per customer checkout
-- ------------------------------------------------------------
CREATE TABLE `orders` (
  `order_id`    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` INT UNSIGNED NOT NULL,
  `order_type`  ENUM('dine-in', 'take-out', 'delivery') NOT NULL DEFAULT 'dine-in',
  `status`      ENUM('pending', 'preparing', 'ready', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
  `notes`       VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`order_id`),
  KEY `idx_orders_customer` (`customer_id`),
  KEY `idx_orders_status` (`status`),
  KEY `idx_orders_created` (`created_at`),
  CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- order_items: line items; unit_price is the price at time of order
-- ------------------------------------------------------------
CREATE TABLE `order_items` (
  `order_item_id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      INT UNSIGNED NOT NULL,
  `product_id`    INT UNSIGNED NOT NULL,
  `quantity`      SMALLINT UNSIGNED NOT NULL,
  `unit_price`    DECIMAL(8,2) NOT NULL,
  PRIMARY KEY (`order_item_id`),
  UNIQUE KEY `uq_order_items_order_product` (`order_id`, `product_id`),
  KEY `idx_order_items_product` (`product_id`),
  CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`order_id`) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_order_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `chk_order_items_quantity` CHECK (`quantity` > 0),
  CONSTRAINT `chk_order_items_price` CHECK (`unit_price` >= 0)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- v_order_summary: one row per order with customer and totals
-- ------------------------------------------------------------
CREATE VIEW `v_order_summary` AS
SELECT o.order_id,
       o.customer_id,
       u.full_name  AS customer_name,
       u.phone      AS customer_phone,
       o.order_type,
       o.status,
       o.notes,
       o.created_at,
       COALESCE(SUM(oi.quantity), 0)                 AS item_count,
       COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total_amount
FROM orders o
JOIN users u ON u.user_id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.order_id
GROUP BY o.order_id, o.customer_id, u.full_name, u.phone, o.order_type, o.status, o.notes, o.created_at;

-- No login accounts or orders are seeded. Create the first owner with:
-- php setup_owner.php
-- ============================================================

INSERT INTO `categories` (`category_id`, `name`, `sort_order`) VALUES
(1, 'Rice Meals', 1),
(2, 'Ulam & Add-ons', 2),
(3, 'Merienda', 3),
(4, 'Palamig', 4);

INSERT INTO `products` (`product_id`, `category_id`, `name`, `description`, `unit`, `price`, `image`, `created_by`, `updated_by`) VALUES
(1, 1, 'Chicken Pastil with Rice', 'Shredded chicken pastil served over steamed rice.', '1 meal', 40.00, 'IMAGES/menu/chicken-pastil-rice.jpg', NULL, NULL),
(2, 2, 'Chicken Pastil (No Rice)', 'A serving of savory shredded chicken pastil.', '1 serving', 30.00, 'IMAGES/menu/chicken-pastil.jpg', NULL, NULL),
(3, 2, 'Sunny Side Up Egg', 'Fried egg with crispy edges, perfect with rice.', '1 piece', 15.00, 'IMAGES/menu/sunny-side-up.jpg', NULL, NULL),
(4, 3, 'Siomai', 'Steamed pork siomai.', '1 piece', 5.00, 'IMAGES/menu/siomai-new.jpg', NULL, NULL),
(5, 3, 'Waffle', 'Golden waffle, fresh off the iron.', '1 piece', 20.00, 'IMAGES/menu/waffle.jpg', NULL, NULL),
(6, 3, 'Dynamite', 'Cheese-stuffed green chili wrapped and fried.', '1 piece', 15.00, 'IMAGES/menu/placeholder.svg', NULL, NULL),
(7, 3, 'Banana Cue', 'Caramelized saba banana on a stick.', '1 stick', 15.00, 'IMAGES/menu/banana-cue.jpg', NULL, NULL),
(8, 4, 'Sago''t Gulaman', 'Cold brown-sugar drink with sago and gulaman.', '1 cup', 15.00, 'IMAGES/menu/sago-gulaman.jpg', NULL, NULL),
(9, 3, 'Kamote Cue', 'Caramelized kamote on a stick.', '1 stick', 15.00, 'IMAGES/menu/kamote-cue.jpg', NULL, NULL);
