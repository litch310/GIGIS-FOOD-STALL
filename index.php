<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Gigi's Food House</title>
    <link href="style.css" rel="stylesheet">
</head>
<body data-role="guest">

    <header class="site-header">
        <a class="brand" href="#catalog" onclick="switchNavTab('catalog'); return false;"><span class="brand-mark">G</span><span>Gigi's <em>Food</em> House</span></a>
        <nav class="site-nav">
            <button class="tab-link active" data-tab="catalog" onclick="switchNavTab('catalog')">Menu</button>
            <button class="tab-link role-customer" data-tab="my-orders" onclick="switchNavTab('my-orders')">My orders <em id="nav-open-orders"></em></button>
            <button class="tab-link role-owner" data-tab="owner-orders" onclick="switchNavTab('owner-orders')">Orders <em id="nav-owner-open"></em></button>
            <button class="tab-link role-vendor" data-tab="vendor-orders" onclick="switchNavTab('vendor-orders')">Orders <em id="nav-vendor-open"></em></button>
            <button class="tab-link role-manager" data-tab="manage-menu" onclick="switchNavTab('manage-menu')">Menu manager</button>
            <button class="tab-link role-owner" data-tab="owner-vendors" onclick="switchNavTab('owner-vendors')">Vendors <em id="nav-pending-vendors"></em></button>
            <button class="tab-link role-owner" data-tab="owner-customers" onclick="switchNavTab('owner-customers')">Customers</button>
            <button class="cart-link role-buyer" onclick="openCartModal()">Your tray <span id="header-cart-count">0</span></button>
            <span class="user-name role-signed-in" id="header-user-name"></span>
            <button class="nav-button role-signed-in" onclick="logout()">Sign out</button>
            <button class="tab-link role-guest" data-tab="auth" onclick="switchNavTab('auth')">Sign in</button>
        </nav>
    </header>

    <div class="flash" id="flash-message" style="display: none;"></div>

    <!-- ========================================== -->
    <!-- MENU (public)                              -->
    <!-- ========================================== -->
    <main id="tab-catalog" class="tab-view active">
        <section class="hero">
            <div class="hero-copy">
                <p class="eyebrow">Welcome to</p>
                <h1>Gigi's<br><i>Food House.</i></h1>
                <p class="hero-text">Gigi's little canteen serving siomai, chicken pastil, waffles and merienda favorites, hot from the kitchen and easy on the baon.</p>
                <a class="button button-dark" href="#menu">Explore the menu <span>↓</span></a>
            </div>
            <div class="hero-banner">
                <div class="banner-top"><span class="banner-tag">Now serving</span><span>Dine-in · Take-out · Delivery</span></div>
                <h2>Lutong bahay,<br><i>sulit sa presyo.</i></h2>
                <ul class="banner-menu" id="banner-menu"></ul>
                <div class="banner-foot"><span>Gigi's Food House</span><span>Order at the counter or add to your tray ↓</span></div>
            </div>
        </section>

        <section class="menu-section" id="menu">
            <div class="section-heading">
                <div><p class="eyebrow">The menu</p><h2>Made fresh.<br>Every day.</h2></div>
                <div class="menu-tools">
                    <p>Rice meals, ulam, merienda and palamig, all priced for everyday.</p>
                    <input id="product-search-input" class="line-input" type="search" placeholder="Search siomai, pastil, waffle..." autocomplete="off" oninput="onSearchInput()">
                </div>
            </div>
            <div class="category-nav" id="category-chips-container"></div>
            <p class="menu-count">Showing <strong id="visible-count">0</strong> of <span id="total-count">0</span> items</p>
            <div class="product-grid" id="products-grid-container"></div>
            <div class="pager" id="catalog-pagination"></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- SIGN IN / CREATE ACCOUNT                   -->
    <!-- ========================================== -->
    <main id="tab-auth" class="tab-view">
        <div class="auth-card" id="login-card">
            <p class="eyebrow">Welcome back</p>
            <h1>Good to see<br><i>you again.</i></h1>
            <p class="auth-intro">Sign in to place your order and keep track of it from the kitchen to your table.</p>
            <form class="checkout-form" onsubmit="submitAuth(event, 'login')">
                <label>Email<input type="email" name="email" required autocomplete="email"></label>
                <div class="password-control">
                    <label for="login-password">Password</label>
                    <div class="password-input-wrap">
                        <input id="login-password" type="password" name="password" required autocomplete="current-password">
                        <button class="password-toggle" type="button" aria-label="Show password" aria-pressed="false" title="Show password" onclick="togglePasswordVisibility('login-password', this)">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        </button>
                    </div>
                </div>
                <div class="form-errors" style="display: none;"></div>
                <button class="button button-dark" type="submit">Sign in <span>→</span></button>
            </form>
            <p class="auth-switch"><a href="#auth" onclick="showAuthCard('forgot'); return false;">Forgot your password?</a></p>
            <p class="auth-switch">New here? <a href="#auth" onclick="showAuthCard('register'); return false;">Create an account</a></p>
        </div>

        <div class="auth-card auth-card-wide" id="register-card" style="display: none;">
            <p class="eyebrow">Create an account</p>
            <h1>Join the<br><i>canteen.</i></h1>
            <p class="auth-intro" id="register-intro">Order ahead as a customer, or sign up as a vendor if you work at Gigi's Food House.</p>
            <form class="checkout-form" id="register-form" onsubmit="submitAuth(event, 'register')">
                <fieldset class="account-type">
                    <legend>I want to...</legend>
                    <label class="account-option">
                        <input type="radio" name="account_type" value="customer" checked onchange="onAccountTypeChange()">
                        <span><strong>Order food</strong><small>Customer account. Order ahead and track your food.</small></span>
                    </label>
                    <label class="account-option">
                        <input type="radio" name="account_type" value="vendor" onchange="onAccountTypeChange()">
                        <span><strong>Work at Gigi's</strong><small>Vendor account. Add, update and remove dishes on Gigi's menu.</small></span>
                    </label>
                </fieldset>
                <label>Full name<input name="full_name" required maxlength="100" autocomplete="name"></label>
                <div class="form-row">
                    <label>Email<input type="email" name="email" required autocomplete="email"></label>
                    <label>Phone <span id="phone-optional">(optional)</span><input name="phone" maxlength="20" autocomplete="tel"></label>
                </div>
                <div class="vendor-fields" id="vendor-fields" style="display: none;">
                    <p class="field-note">Vendor accounts are for Gigi's Food House staff. Gigi approves your account first, then you can add new dishes, update prices, mark dishes sold out and remove dishes that are no longer served.</p>
                </div>
                <div class="password-control">
                    <label for="register-password">Password</label>
                    <div class="password-input-wrap">
                        <input id="register-password" type="password" name="password" required minlength="8" pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9\s]).{8,}" title="Use at least 8 characters, including a lowercase letter, an uppercase letter, a number and a special character." autocomplete="new-password">
                        <button class="password-toggle" type="button" aria-label="Show password" aria-pressed="false" title="Show password" onclick="togglePasswordVisibility('register-password', this)">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        </button>
                    </div>
                    <p class="password-hint">At least 8 characters, with a lowercase letter, uppercase letter, number and special character.</p>
                </div>
                <div class="form-errors" style="display: none;"></div>
                <button class="button button-dark" type="submit">Create account <span>→</span></button>
            </form>
            <p class="auth-switch">Already have an account? <a href="#auth" onclick="showAuthCard('login'); return false;">Sign in</a></p>
        </div>

        <div class="auth-card" id="forgot-card" style="display: none;">
            <p class="eyebrow">Account recovery</p>
            <h1>Forgot your<br><i>password?</i></h1>
            <p class="auth-intro">Enter the email address on your account. If there's an eligible account, we'll send you a password reset link.</p>
            <form class="checkout-form" onsubmit="submitAuth(event, 'forgot-password')">
                <label>Email<input type="email" name="email" required autocomplete="email"></label>
                <div class="form-errors" style="display: none;"></div>
                <p class="auth-feedback" role="status" aria-live="polite" style="display: none;"></p>
                <button class="button button-dark" type="submit">Send reset link <span>→</span></button>
            </form>
            <p class="auth-switch"><a href="#auth" onclick="showAuthCard('login'); return false;">Back to sign in</a></p>
        </div>

        <div class="auth-card" id="verification-card" style="display: none;">
            <p class="eyebrow">Email verification</p>
            <h1>Waiting for<br><i>verification.</i></h1>
            <p class="auth-intro verification-status" id="verification-status" role="status" aria-live="polite">Check your inbox for the verification link. Didn't get a verification email? You can resend it below.</p>
            <form class="checkout-form" id="verification-form" onsubmit="submitAuth(event, 'resend-verification')">
                <label>Email<input id="verification-email" type="email" name="email" required autocomplete="email"></label>
                <div class="form-errors" style="display: none;"></div>
                <button class="button button-dark" type="submit">Resend verification <span>→</span></button>
            </form>
            <p class="auth-switch"><a href="#auth" onclick="returnToLogin(); return false;">Back to sign in</a></p>
        </div>

        <div class="auth-card" id="reset-card" style="display: none;">
            <p class="eyebrow">Account recovery</p>
            <h1>Choose a new<br><i>password.</i></h1>
            <p class="auth-intro">Use at least 8 characters, including a lowercase letter, an uppercase letter, a number and a special character.</p>
            <form class="checkout-form" onsubmit="submitAuth(event, 'reset-password')">
                <input type="hidden" name="token" id="reset-token">
                <label>New password<input type="password" name="password" required minlength="8" pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9\s]).{8,}" autocomplete="new-password"></label>
                <div class="form-errors" style="display: none;"></div>
                <button class="button button-dark" type="submit">Update password <span>→</span></button>
            </form>
            <p class="auth-switch"><a href="#auth" onclick="showAuthCard('login'); return false;">Back to sign in</a></p>
        </div>
    </main>

    <!-- ========================================== -->
    <!-- CUSTOMER: MY ORDERS                        -->
    <!-- ========================================== -->
    <main id="tab-my-orders" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Your account</p>
                <h1><span class="js-first-name">Hi</span>, <i>your orders.</i></h1>
            </div>
            <button class="button button-dark" onclick="switchNavTab('catalog')">Browse menu <span>→</span></button>
        </div>

        <div class="stat-grid">
            <div><span>Orders placed</span><strong id="my-order-count">0</strong></div>
            <div><span>In the kitchen</span><strong id="my-open-count">0</strong></div>
            <div><span>Total spent</span><strong id="my-total-spent">₱0.00</strong></div>
        </div>

        <section class="admin-orders">
            <div class="admin-orders-head"><h2>Order history</h2><span class="js-today"></span></div>
            <div id="my-orders-list"><p class="empty-row">Loading orders...</p></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- OWNER: ORDERS DASHBOARD                    -->
    <!-- ========================================== -->
    <main id="tab-owner-orders" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Back of house</p>
                <h1><span class="js-first-name">Gigi</span>, <i>at a glance.</i></h1>
            </div>
            <button class="button button-dark" onclick="loadOwnerDashboard()">Refresh <span>↻</span></button>
        </div>

        <div class="stat-grid four">
            <div><span>Today's sales</span><strong id="kpi-today-sales">₱0.00</strong></div>
            <div><span>Open orders</span><strong id="kpi-open-orders">0</strong></div>
            <div><span>Total sales</span><strong id="kpi-total-sales">₱0.00</strong><small id="kpi-total-orders"></small></div>
            <div><span>Best seller</span><strong id="kpi-top-item">-</strong></div>
        </div>

        <section class="admin-orders">
            <div class="admin-orders-head">
                <h2>Orders</h2>
                <input type="search" id="owner-order-search" class="line-input" placeholder="Search order # or customer..." oninput="renderOwnerOrders()">
            </div>
            <div class="category-nav" id="status-filter"></div>
            <div id="owner-orders-list"><p class="empty-row">Loading orders...</p></div>
            <div class="pager" id="owner-orders-pagination"></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- OWNER & VENDOR: DISH MANAGER               -->
    <!-- ========================================== -->
    <main id="tab-manage-menu" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Menu manager</p>
                <h1>Gigi's menu, <i>kept fresh.</i></h1>
            </div>
            <button class="button button-dark js-menu-editor" onclick="openProductModal(0)">Add dish <span>+</span></button>
        </div>

        <div class="stall-notice js-account-notice" style="display: none;"></div>

        <section class="admin-orders">
            <div class="admin-orders-head"><h2>Dishes</h2><span id="owner-menu-count"></span></div>
            <div id="owner-menu-list"></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- VENDOR: CUSTOMER ORDERS                    -->
    <!-- ========================================== -->
    <main id="tab-vendor-orders" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Vendor desk</p>
                <h1><span class="js-first-name">Vendor</span>, <i>orders to fill.</i></h1>
            </div>
            <button class="button button-dark" onclick="loadVendorOrders()">Refresh <span>↻</span></button>
        </div>

        <section class="admin-orders">
            <div class="admin-orders-head">
                <h2>Customer orders</h2>
                <input type="search" id="vendor-order-search" class="line-input" placeholder="Search order # or customer..." oninput="renderVendorOrders()">
            </div>
            <p class="orders-summary" id="vendor-orders-count"></p>
            <div id="vendor-orders-list"><p class="empty-row">Loading orders...</p></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- OWNER: VENDORS                             -->
    <!-- ========================================== -->
    <main id="tab-owner-vendors" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Vendors</p>
                <h1>Gigi's team, <i>on the menu.</i></h1>
            </div>
        </div>

        <section class="admin-orders">
            <div class="admin-orders-head"><h2>Vendor accounts</h2><span id="owner-vendor-count"></span></div>
            <div id="owner-vendors-list"><p class="empty-row">Loading vendors...</p></div>
        </section>
    </main>

    <!-- ========================================== -->
    <!-- OWNER: CUSTOMERS                           -->
    <!-- ========================================== -->
    <main id="tab-owner-customers" class="tab-view admin-page">
        <div class="admin-heading">
            <div>
                <p class="eyebrow">Customers</p>
                <h1>Your regulars, <i>by name.</i></h1>
            </div>
        </div>

        <section class="admin-orders">
            <div class="admin-orders-head"><h2>Customers</h2><span id="owner-customer-count"></span></div>
            <div id="owner-customers-list"><p class="empty-row">Loading customers...</p></div>
        </section>
    </main>

    <footer class="site-footer"><span>Gigi's Food House</span><span>Lutong bahay, served with a smile.</span></footer>

    <!-- ========================================== -->
    <!-- MODAL: TRAY & CHECKOUT                     -->
    <!-- ========================================== -->
    <div class="modal-overlay" id="cartModal" onclick="if (event.target === this) closeModal('cartModal')">
        <div class="modal-panel">
            <div class="modal-head">
                <div><p class="eyebrow">Your tray</p><h2>A little something<br><i>for everyone.</i></h2></div>
                <button class="modal-close" onclick="closeModal('cartModal')" aria-label="Close">×</button>
            </div>

            <div id="cart-empty-view" class="empty-panel" style="display: none;">
                <p>Your tray is waiting for something delicious.</p>
                <button class="button button-dark" onclick="closeModal('cartModal')">Browse the menu</button>
            </div>

            <div id="cart-items-view" class="order-layout">
                <div class="order-items" id="cart-items-list"></div>
                <aside class="order-summary">
                    <p class="eyebrow">Order details</p>
                    <div id="checkout-signed-in">
                        <label>Ordering as<input type="text" id="checkout-customer" readonly></label>
                        <label>Order type
                            <select id="checkout-order-type">
                                <option value="dine-in">Dine-in</option>
                                <option value="take-out">Take-out</option>
                                <option value="delivery">Delivery</option>
                            </select>
                        </label>
                        <label>Notes for the kitchen <span>(optional)</span><input type="text" id="checkout-notes" maxlength="255" placeholder="e.g. no ice, extra sauce, room 204"></label>
                    </div>
                    <hr>
                    <div class="total"><span>Total</span><strong id="cart-grand-total">₱0.00</strong></div>
                    <button class="button button-dark full" id="place-order-submit-btn" onclick="submitCartOrder()">Place order <span>→</span></button>
                </aside>
            </div>
        </div>
    </div>

    <!-- ========================================== -->
    <!-- MODAL: ORDER LINE ITEMS                    -->
    <!-- ========================================== -->
    <div class="modal-overlay" id="orderDetailsModal" onclick="if (event.target === this) closeModal('orderDetailsModal')">
        <div class="modal-panel narrow">
            <div class="modal-head">
                <div><p class="eyebrow" id="order-details-eyebrow">Order</p><h2 id="order-details-title">Order</h2></div>
                <button class="modal-close" onclick="closeModal('orderDetailsModal')" aria-label="Close">×</button>
            </div>
            <p id="order-details-loading" class="loading-note">Retrieving order details...</p>
            <div id="order-details-content" style="display: none;">
                <div class="order-items" id="order-details-list"></div>
                <div class="order-summary" style="margin-top: 28px;">
                    <div><span>Order type</span><strong id="order-details-type"></strong></div>
                    <div id="order-details-notes-row"><span>Notes</span><strong id="order-details-notes"></strong></div>
                    <div><span id="order-details-qty">0 items</span></div>
                    <div class="total"><span>Order total</span><strong id="order-details-total">₱0.00</strong></div>
                </div>
            </div>
        </div>
    </div>

    <!-- ========================================== -->
    <!-- MODAL: ADD / EDIT PRODUCT (owner)          -->
    <!-- ========================================== -->
    <div class="modal-overlay" id="productModal" onclick="if (event.target === this) closeModal('productModal')">
        <div class="modal-panel narrow">
            <div class="modal-head">
                <div><p class="eyebrow" id="product-modal-eyebrow">Menu manager</p><h2 id="product-modal-title">Add <i>a dish.</i></h2></div>
                <button class="modal-close" onclick="closeModal('productModal')" aria-label="Close">×</button>
            </div>
            <form class="checkout-form" id="product-form" onsubmit="submitProduct(event)">
                <input type="hidden" name="product_id" value="0">
                <div class="form-row">
                    <label>Name<input name="name" required maxlength="100"></label>
                    <label>Category<select name="category_id" id="product-category-select" required></select></label>
                </div>
                <div class="form-row">
                    <label>Price (₱)<input name="price" type="number" min="0" step="0.25" required></label>
                    <label>Unit<input name="unit" required maxlength="30" placeholder="1 piece, 1 cup, 1 meal"></label>
                </div>
                <label>Description <span>(optional)</span><textarea name="description" rows="2" maxlength="255"></textarea></label>
                <div class="form-row">
                    <label>Photo <span>(JPG, PNG or WEBP, up to 3 MB)</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>
                    <label>Availability
                        <select name="is_available">
                            <option value="1">Available</option>
                            <option value="0">Sold out</option>
                        </select>
                    </label>
                </div>
                <img id="product-form-preview" class="product-form-preview" alt="" style="display: none;">
                <div class="form-errors" style="display: none;"></div>
                <button class="button button-dark" type="submit" id="product-form-submit">Save dish <span>→</span></button>
            </form>
        </div>
    </div>

    <script src="app.js" defer></script>
</body>
</html>
