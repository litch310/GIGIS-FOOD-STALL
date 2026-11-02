        var STATUSES = ['pending', 'preparing', 'ready', 'completed', 'cancelled'];
        var ORDER_TYPE_LABELS = { 'dine-in': 'Dine-in', 'take-out': 'Take-out', 'delivery': 'Delivery' };

        // Global App State
        var appState = {
            user: null,
            csrf: '',
            categories: [],
            products: [],
            cart: [],
            activeTab: 'catalog',
            activeCategory: 'all',
            searchQuery: '',
            checkoutAfterLogin: false,

            catalogPage: 1,
            catalogPageSize: 9,

            myOrders: [],

            ownerOrders: [],
            ownerStatusFilter: 'open',
            ownerOrdersPage: 1,
            ownerOrdersPageSize: 10,
            vendorOrders: [],
            customers: [],

            manageProducts: [],
            ownerVendors: []
        };

        // ------------------------------------------------------------
        // API helper: adds the CSRF token to every POST
        // ------------------------------------------------------------
        function api(action, body) {
            var options = { credentials: 'same-origin' };
            var url = 'api.php?action=' + action;
            if (body) {
                var form = body instanceof FormData ? body : new FormData();
                if (!(body instanceof FormData)) {
                    Object.keys(body).forEach(function(k) { form.append(k, body[k]); });
                }
                form.append('action', action);
                options.method = 'POST';
                options.body = form;
                options.headers = { 'X-CSRF-Token': appState.csrf };
                url = 'api.php';
            }
            return fetch(url, options)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (!data.success) {
                        var error = new Error(data.message || 'Something went wrong.');
                        error.code = data.code || '';
                        throw error;
                    }
                    if (data.csrf) appState.csrf = data.csrf;
                    return data;
                });
        }

        // ------------------------------------------------------------
        // Startup & session
        // ------------------------------------------------------------
        function initApp() {
            document.querySelectorAll('.js-today').forEach(function(el) { el.textContent = new Date().toDateString(); });
            loadSavedCart();
            updateCartHeaderBadge();
            api('me')
                .then(function(data) {
                    setUser(data.user);
                    var params = new URLSearchParams(location.hash.slice(1));
                    var verifyToken = params.get('verify');
                    var resetToken = params.get('reset');
                    if (verifyToken) {
                        history.replaceState(null, '', location.pathname + location.search);
                        switchNavTab('auth', true);
                        showAuthCard('login');
                        api('verify-email', { token: verifyToken })
                            .then(function(result) {
                                clearPendingVerificationEmail();
                                showAuthCard('login');
                                showFlash(result.message, 'success');
                            })
                            .catch(function(err) {
                                showVerificationDashboard('', err.message + ' Enter your email below to request a fresh link.', 'error');
                            });
                        return;
                    }
                    if (resetToken) {
                        switchNavTab('auth', true);
                        document.getElementById('reset-token').value = resetToken;
                        showAuthCard('reset');
                        history.replaceState(null, '', location.pathname + location.search + '#reset=' + encodeURIComponent(resetToken));
                        return;
                    }
                    var hashTab = location.hash.replace('#', '');
                    if (hashTab && document.getElementById('tab-' + hashTab)) switchNavTab(hashTab);
                    var pendingEmail = getPendingVerificationEmail();
                    if (pendingEmail && location.hash === '#auth') {
                        switchNavTab('auth', true);
                        showVerificationDashboard(pendingEmail);
                    }
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function setUser(user) {
            appState.user = user;
            var role = user ? user.role : 'guest';
            document.body.dataset.role = role;
            document.body.classList.toggle('can-edit-menu', canEditMenu());
            document.getElementById('header-user-name').textContent = user ? user.full_name : '';
            document.querySelectorAll('.js-first-name').forEach(function(el) {
                el.textContent = user ? user.full_name.split(' ')[0] : '';
            });
            renderAccountNotice();

            loadMenu();
            if (role === 'customer') loadMyOrders();
            if (role === 'owner' || role === 'vendor') {
                appState.cart = [];
                updateCartHeaderBadge();
                loadManageProducts();
            }
            if (role === 'vendor') loadVendorOrders();
            if (role === 'owner') {
                loadOwnerDashboard();
                loadOwnerVendors();
                loadCustomers();
            }
        }

        function isOwner() { return appState.user && appState.user.role === 'owner'; }
        function isVendor() { return appState.user && appState.user.role === 'vendor'; }
        function isCustomer() { return appState.user && appState.user.role === 'customer'; }
        function canBuy() { return !appState.user || isCustomer(); }
        // The owner and approved vendors can change the menu
        function canEditMenu() { return isOwner() || (isVendor() && appState.user.status === 'active'); }

        // Vendors waiting for approval see a note on the menu manager
        function renderAccountNotice() {
            var text = isVendor() && appState.user.status === 'pending'
                ? '<strong>Your vendor account is waiting for Gigi\'s approval.</strong> You can look around now; once approved, you can add, update and remove dishes.'
                : '';
            document.querySelectorAll('.js-account-notice').forEach(function(el) {
                el.innerHTML = text;
                el.style.display = text ? '' : 'none';
            });
        }

        function onAccountTypeChange() {
            var form = document.getElementById('register-form');
            var vendor = form.elements['account_type'].value === 'vendor';
            document.getElementById('vendor-fields').style.display = vendor ? '' : 'none';
            form.elements['phone'].required = vendor;
            document.getElementById('phone-optional').textContent = vendor ? '(for the owner to reach you)' : '(optional)';
            form.querySelector('button[type="submit"]').innerHTML = (vendor ? 'Create vendor account' : 'Create account') + ' <span>→</span>';
        }

        function showAuthCard(which) {
            if (which !== 'reset' && location.hash.indexOf('#reset=') === 0) {
                history.replaceState(null, '', location.pathname + location.search + '#auth');
            }
            ['login', 'register', 'forgot', 'verification', 'reset'].forEach(function(card) {
                document.getElementById(card + '-card').style.display = which === card ? '' : 'none';
            });
            if (which !== 'login') resetPasswordVisibility(document.querySelector('#login-card form'));
            if (which !== 'register') resetPasswordVisibility(document.querySelector('#register-card form'));
        }

        var PENDING_VERIFICATION_KEY = 'adbms-pending-verification-email';
        function getPendingVerificationEmail() {
            try { return sessionStorage.getItem(PENDING_VERIFICATION_KEY) || ''; }
            catch (e) { return ''; }
        }

        function rememberPendingVerificationEmail(email) {
            try {
                if (email) sessionStorage.setItem(PENDING_VERIFICATION_KEY, email);
                else sessionStorage.removeItem(PENDING_VERIFICATION_KEY);
            } catch (e) {}
        }

        function clearPendingVerificationEmail() {
            rememberPendingVerificationEmail('');
        }

        function showVerificationDashboard(email, message, state) {
            var form = document.getElementById('verification-form');
            var input = form.elements.email;
            var normalizedEmail = (email || input.value || getPendingVerificationEmail() || '').trim();
            if (normalizedEmail) input.value = normalizedEmail;
            rememberPendingVerificationEmail(normalizedEmail);
            var status = document.getElementById('verification-status');
            status.textContent = message || 'Check your inbox for the verification link. Didn\'t get a verification email? You can resend it below.';
            status.dataset.state = state || 'info';
            showAuthCard('verification');
            switchNavTab('auth', true);
        }

        function returnToLogin() {
            clearPendingVerificationEmail();
            showAuthCard('login');
        }

        function togglePasswordVisibility(inputId, button) {
            var input = document.getElementById(inputId);
            var showing = input.type === 'password';
            input.type = showing ? 'text' : 'password';
            button.setAttribute('aria-pressed', showing ? 'true' : 'false');
            button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
            button.title = showing ? 'Hide password' : 'Show password';
        }

        function resetPasswordVisibility(form) {
            form.querySelectorAll('.password-input-wrap').forEach(function(wrapper) {
                var input = wrapper.querySelector('input');
                var button = wrapper.querySelector('.password-toggle');
                input.type = 'password';
                button.setAttribute('aria-pressed', 'false');
                button.setAttribute('aria-label', 'Show password');
                button.title = 'Show password';
            });
        }

        function submitAuth(event, action) {
            event.preventDefault();
            var form = event.target;
            var errorEl = form.querySelector('.form-errors');
            var btn = form.querySelector('button[type="submit"]');
            errorEl.style.display = 'none';
            var feedbackEl = form.querySelector('.auth-feedback');
            if (feedbackEl) feedbackEl.style.display = 'none';
            btn.disabled = true;

            api(action, new FormData(form))
                .then(function(data) {
                    if (action === 'register') {
                        var registeredEmail = form.elements.email.value;
                        form.reset();
                        onAccountTypeChange();
                        showVerificationDashboard(registeredEmail, data.message, 'success');
                        return;
                    }
                    if (action === 'forgot-password') {
                        feedbackEl.textContent = data.message;
                        feedbackEl.className = 'auth-feedback success';
                        feedbackEl.style.display = 'block';
                        return;
                    }
                    if (action === 'resend-verification') {
                        showVerificationDashboard(form.elements.email.value, data.message, 'info');
                        return;
                    }
                    if (action === 'reset-password') {
                        form.reset();
                        setUser(null);
                        if (data.verification_required) {
                            showVerificationDashboard(data.email, data.message, 'info');
                            return;
                        }
                        switchNavTab('auth', true);
                        showAuthCard('login');
                        showFlash(data.message, 'success');
                        return;
                    }
                    resetPasswordVisibility(form);
                    form.reset();
                    setUser(data.user);
                    showFlash('Welcome, ' + data.user.full_name.split(' ')[0] + '!', 'success');
                    if (isOwner()) {
                        switchNavTab('owner-orders');
                    } else if (isVendor()) {
                        switchNavTab('manage-menu');
                    } else {
                        switchNavTab('catalog');
                        if (appState.checkoutAfterLogin) openCartModal();
                    }
                    appState.checkoutAfterLogin = false;
                })
                .catch(function(err) {
                    if (action === 'login' && err.code === 'email_unverified') {
                        showVerificationDashboard(form.elements.email.value, err.message + ' Use the resend form below if needed.', 'error');
                        return;
                    }
                    if (action === 'register' && err.code === 'verification_pending') {
                        showVerificationDashboard(form.elements.email.value, err.message, 'error');
                        return;
                    }
                    errorEl.textContent = err.message;
                    errorEl.style.display = 'block';
                })
                .then(function() { btn.disabled = false; });
        }

        function logout() {
            api('logout', {})
                .then(function() {
                    appState.cart = [];
                    updateCartHeaderBadge();
                    setUser(null);
                    switchNavTab('catalog');
                    showFlash('Signed out. Balik ka ha!', 'success');
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        // ------------------------------------------------------------
        // Menu
        // ------------------------------------------------------------
        function loadMenu() {
            return api('menu')
                .then(function(data) {
                    appState.categories = data.categories;
                    appState.products = data.products;
                    renderCategoryChips();
                    renderBanner();
                    renderCatalog();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        // Hero banner: everything available, cheapest first
        function renderBanner() {
            var list = document.getElementById('banner-menu');
            var items = appState.products.filter(function(p) { return p.is_available; });
            items.sort(function(a, b) { return a.price - b.price; });

            var html = '';
            items.slice(0, 9).forEach(function(p) {
                html += '<li title="Add to tray" onclick="addBannerItem(' + p.product_id + ')">' +
                    '<img src="' + escapeHtml(productImage(p)) + '" alt="">' +
                    '<span class="banner-name">' + escapeHtml(p.name) + '</span>' +
                    '<span class="banner-dots"></span>' +
                    '<strong>' + peso(p.price, 0) + '</strong>' +
                '</li>';
            });
            list.innerHTML = html;
        }

        function addBannerItem(productId) {
            if (!canBuy()) return;
            var product = findProduct(productId);
            if (!product) return;
            addToCart(productId, null);
            showFlash(product.name + ' added to your tray.', 'success');
        }

        function renderCategoryChips() {
            var container = document.getElementById('category-chips-container');
            var html = '<a href="#menu" class="' + (appState.activeCategory === 'all' ? 'active' : '') + '" onclick="filterCategory(\'all\'); return false;">Everything</a>';
            appState.categories.forEach(function(cat) {
                var isActive = (String(cat.category_id) === String(appState.activeCategory));
                html += '<a href="#menu" class="' + (isActive ? 'active' : '') + '" onclick="filterCategory(' + cat.category_id + '); return false;">' + escapeHtml(cat.name) + '</a>';
            });
            container.innerHTML = html;
        }

        function filterCategory(catId) {
            appState.activeCategory = String(catId);
            appState.catalogPage = 1;
            renderCategoryChips();
            renderCatalog();
        }

        function onSearchInput() {
            appState.searchQuery = document.getElementById('product-search-input').value.toLowerCase().trim();
            appState.catalogPage = 1;
            renderCatalog();
        }

        function renderCatalog() {
            var container = document.getElementById('products-grid-container');

            var filtered = appState.products.filter(function(p) {
                var matchesCat = (appState.activeCategory === 'all' || String(p.category_id) === String(appState.activeCategory));
                var matchesSearch = (p.name.toLowerCase().indexOf(appState.searchQuery) !== -1);
                return matchesCat && matchesSearch;
            });

            document.getElementById('visible-count').textContent = filtered.length;
            document.getElementById('total-count').textContent = appState.products.length;

            var totalPages = Math.max(1, Math.ceil(filtered.length / appState.catalogPageSize));
            if (appState.catalogPage > totalPages) appState.catalogPage = totalPages;
            var start = (appState.catalogPage - 1) * appState.catalogPageSize;
            var pagedItems = filtered.slice(start, start + appState.catalogPageSize);

            if (pagedItems.length === 0) {
                container.innerHTML = '<p class="empty-state">Nothing on the menu matches that. Try a different dish or category.</p>';
            } else {
                var html = '';
                pagedItems.forEach(function(p) {
                    var badge = !p.is_available ? '<span class="product-rank sold-out">Sold out</span>'
                        : (p.rank > 0 ? '<span class="product-rank">Best seller #' + p.rank + '</span>' : '');
                    var buyButton = (!canBuy() || !p.is_available) ? ''
                        : '<button class="add-button" title="Add ' + escapeHtml(p.name) + ' to tray" onclick="addToCart(' + p.product_id + ', this)">+</button>';

                    html += '<article class="product-card' + (p.is_available ? '' : ' is-sold-out') + '">' +
                        '<div class="product-image">' +
                            '<img src="' + escapeHtml(productImage(p)) + '" alt="' + escapeHtml(p.name) + '" loading="lazy">' +
                            badge +
                            '<span class="product-category">' + escapeHtml(p.category_name) + '</span>' +
                        '</div>' +
                        '<div class="product-info">' +
                            '<div>' +
                                '<h3>' + escapeHtml(p.name) + '</h3>' +
                                '<p>' + escapeHtml(p.description || p.unit) + '</p>' +
                                (p.description ? '<p class="product-unit">' + escapeHtml(p.unit) + '</p>' : '') +
                            '</div>' +
                            '<div class="product-buy">' +
                                '<strong>' + peso(p.price) + '</strong>' +
                                buyButton +
                            '</div>' +
                        '</div>' +
                    '</article>';
                });
                container.innerHTML = html;
            }

            renderPagination('catalog-pagination', appState.catalogPage, totalPages, function(newPage) {
                appState.catalogPage = newPage;
                renderCatalog();
                document.getElementById('menu').scrollIntoView();
            });
        }

        // ------------------------------------------------------------
        // Tray & checkout (guests and customers)
        // ------------------------------------------------------------
        function addToCart(productId, btnEl) {
            var product = findProduct(productId);
            if (!canBuy() || !product || !product.is_available) return;

            var existing = appState.cart.find(function(item) { return item.product_id === productId; });
            if (existing) {
                existing.quantity += 1;
            } else {
                appState.cart.push({ product_id: productId, quantity: 1 });
            }
            updateCartHeaderBadge();

            if (btnEl) {
                btnEl.textContent = '✓';
                btnEl.classList.add('added');
                setTimeout(function() {
                    btnEl.textContent = '+';
                    btnEl.classList.remove('added');
                }, 600);
            }
        }

        // Every tray change ends here, so this also saves the tray for the next visit
        function updateCartHeaderBadge() {
            var totalItems = appState.cart.reduce(function(sum, item) { return sum + item.quantity; }, 0);
            document.getElementById('header-cart-count').textContent = totalItems;
            saveCart();
        }

        var CART_STORAGE_KEY = 'adbms-tray';
        function saveCart() {
            try {
                if (appState.cart.length) localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(appState.cart));
                else localStorage.removeItem(CART_STORAGE_KEY);
            } catch (e) {}
        }

        // Prices and availability are re-checked against the menu when the tray opens
        function loadSavedCart() {
            try {
                var saved = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]');
                if (!Array.isArray(saved)) return;
                appState.cart = saved.filter(function(item) {
                    return item && Number.isInteger(item.product_id) && Number.isInteger(item.quantity)
                        && item.quantity > 0 && item.quantity <= 99;
                });
            } catch (e) {}
        }

        function openCartModal() {
            var emptyView = document.getElementById('cart-empty-view');
            var itemsView = document.getElementById('cart-items-view');
            var submitBtn = document.getElementById('place-order-submit-btn');

            // Drop anything that went off the menu since it was added
            appState.cart = appState.cart.filter(function(item) {
                var p = findProduct(item.product_id);
                return p && p.is_available;
            });
            updateCartHeaderBadge();

            if (appState.cart.length === 0) {
                emptyView.style.display = 'block';
                itemsView.style.display = 'none';
            } else {
                emptyView.style.display = 'none';
                itemsView.style.display = '';

                var html = '';
                var grandTotal = 0;
                appState.cart.forEach(function(item, idx) {
                    var p = findProduct(item.product_id);
                    var subtotal = p.price * item.quantity;
                    grandTotal += subtotal;

                    html += '<div class="order-item">' +
                        '<img src="' + escapeHtml(productImage(p)) + '" alt="' + escapeHtml(p.name) + '">' +
                        '<div class="order-item-main">' +
                            '<h3>' + escapeHtml(p.name) + '</h3>' +
                            '<p>' + peso(p.price) + ' each</p>' +
                            '<div class="qty-control">' +
                                '<button onclick="changeCartQuantity(' + idx + ', -1)" aria-label="Less">−</button>' +
                                '<span>' + item.quantity + '</span>' +
                                '<button onclick="changeCartQuantity(' + idx + ', 1)" aria-label="More">+</button>' +
                            '</div>' +
                        '</div>' +
                        '<strong>' + peso(subtotal) + '</strong>' +
                        '<button class="remove-button" onclick="removeCartItem(' + idx + ')" title="Remove item">×</button>' +
                    '</div>';
                });
                document.getElementById('cart-items-list').innerHTML = html;
                document.getElementById('cart-grand-total').textContent = peso(grandTotal);
            }

            var signedIn = isCustomer();
            document.getElementById('checkout-signed-in').style.display = signedIn ? '' : 'none';
            document.getElementById('checkout-customer').value = signedIn ? appState.user.full_name : '';
            submitBtn.innerHTML = signedIn ? 'Place order <span>→</span>' : 'Sign in to order <span>→</span>';

            openModal('cartModal');
        }

        function changeCartQuantity(index, delta) {
            if (!appState.cart[index]) return;
            appState.cart[index].quantity = Math.min(99, appState.cart[index].quantity + delta);
            if (appState.cart[index].quantity <= 0) appState.cart.splice(index, 1);
            updateCartHeaderBadge();
            openCartModal();
        }

        function removeCartItem(index) {
            appState.cart.splice(index, 1);
            updateCartHeaderBadge();
            openCartModal();
        }

        function submitCartOrder() {
            if (appState.cart.length === 0) return;
            if (!isCustomer()) {
                appState.checkoutAfterLogin = true;
                closeModal('cartModal');
                showAuthCard('login');
                switchNavTab('auth');
                return;
            }

            var submitBtn = document.getElementById('place-order-submit-btn');
            submitBtn.disabled = true;
            submitBtn.innerHTML = 'Placing order...';

            api('place_order', {
                order_type: document.getElementById('checkout-order-type').value,
                notes: document.getElementById('checkout-notes').value,
                cart: JSON.stringify(appState.cart)
            })
                .then(function(data) {
                    closeModal('cartModal');
                    appState.cart = [];
                    updateCartHeaderBadge();
                    document.getElementById('checkout-notes').value = '';
                    showFlash(data.message + ' Salamat!', 'success');
                    loadMenu();
                    loadMyOrders();
                    switchNavTab('my-orders');
                })
                .catch(function(err) { showFlash(err.message, 'error'); })
                .then(function() {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Place order <span>→</span>';
                });
        }

        // ------------------------------------------------------------
        // Customer: my orders
        // ------------------------------------------------------------
        function loadMyOrders() {
            if (!isCustomer()) return;
            api('my_orders')
                .then(function(data) {
                    appState.myOrders = data.orders;
                    var open = data.orders.filter(function(o) { return ['pending', 'preparing', 'ready'].indexOf(o.status) !== -1; }).length;
                    document.getElementById('my-order-count').textContent = data.orders.length;
                    document.getElementById('my-open-count').textContent = open;
                    document.getElementById('my-total-spent').textContent = peso(data.total_spent);
                    document.getElementById('nav-open-orders').textContent = open || '';
                    renderMyOrders();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function renderMyOrders() {
            var list = document.getElementById('my-orders-list');
            if (appState.myOrders.length === 0) {
                list.innerHTML = '<p class="empty-row">No orders yet. Pick something from the menu to place your first one.</p>';
                return;
            }
            var html = '';
            appState.myOrders.forEach(function(o) {
                html += '<article class="admin-order">' +
                    '<div class="admin-order-id"><strong>#' + o.order_id + '</strong><span>' + formatDate(o.created_at) + '</span></div>' +
                    '<div><strong>' + ORDER_TYPE_LABELS[o.order_type] + '</strong><p>' + o.item_count + ' items' + (o.notes ? ' · ' + escapeHtml(o.notes) : '') + '</p></div>' +
                    '<div>' + statusPill(o.status) + queuePosition(o) + '</div>' +
                    '<strong>' + peso(o.total_amount) + '</strong>' +
                    '<div class="row-actions">' +
                        '<button class="button button-light button-small" onclick="viewOrderLineItems(' + o.order_id + ')">Details</button>' +
                        (o.status === 'pending' ? '<button class="link-button" onclick="cancelOrder(' + o.order_id + ')">Cancel</button>' : '') +
                    '</div>' +
                '</article>';
            });
            list.innerHTML = html;
        }

        // Pending orders show how many orders the kitchen will finish first
        function queuePosition(o) {
            if (o.status !== 'pending' || o.orders_ahead === undefined) return '';
            return '<p>' + (o.orders_ahead === 0 ? 'Next in line' : plural(o.orders_ahead, 'order', 'orders') + ' ahead of you') + '</p>';
        }

        function cancelOrder(orderId) {
            if (!confirm('Cancel order #' + orderId + '?')) return;
            api('cancel_order', { order_id: orderId })
                .then(function(data) {
                    showFlash(data.message, 'success');
                    loadMyOrders();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        // ------------------------------------------------------------
        // Owner: orders dashboard
        // ------------------------------------------------------------
        function loadOwnerDashboard() {
            if (!isOwner()) return;
            api('owner_dashboard')
                .then(function(data) {
                    appState.ownerOrders = data.orders;
                    var k = data.kpis;
                    document.getElementById('kpi-today-sales').textContent = peso(k.today_sales);
                    document.getElementById('kpi-open-orders').textContent = k.open_orders;
                    document.getElementById('kpi-total-sales').textContent = peso(k.total_sales);
                    document.getElementById('kpi-total-orders').textContent = k.total_orders + ' orders all time';
                    document.getElementById('kpi-top-item').textContent = k.top_item || '-';
                    document.getElementById('nav-owner-open').textContent = k.open_orders || '';
                    document.getElementById('nav-pending-vendors').textContent = k.pending_vendors || '';
                    renderStatusFilter();
                    renderOwnerOrders();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function renderStatusFilter() {
            var filters = [['open', 'Open'], ['all', 'All']].concat(STATUSES.map(function(s) { return [s, capitalize(s)]; }));
            var html = '';
            filters.forEach(function(f) {
                var count = appState.ownerOrders.filter(function(o) { return matchesStatusFilter(o, f[0]); }).length;
                html += '<a href="#owner-orders" class="' + (appState.ownerStatusFilter === f[0] ? 'active' : '') + '" onclick="setStatusFilter(\'' + f[0] + '\'); return false;">' + f[1] + ' <small>' + count + '</small></a>';
            });
            document.getElementById('status-filter').innerHTML = html;
        }

        function matchesStatusFilter(o, filter) {
            if (filter === 'all') return true;
            if (filter === 'open') return ['pending', 'preparing', 'ready'].indexOf(o.status) !== -1;
            return o.status === filter;
        }

        function setStatusFilter(filter) {
            appState.ownerStatusFilter = filter;
            appState.ownerOrdersPage = 1;
            renderStatusFilter();
            renderOwnerOrders();
        }

        function renderOwnerOrders() {
            var list = document.getElementById('owner-orders-list');
            var search = document.getElementById('owner-order-search').value.toLowerCase().trim();

            var filtered = appState.ownerOrders.filter(function(o) {
                var text = ('#' + o.order_id + ' ' + o.customer_name).toLowerCase();
                return matchesStatusFilter(o, appState.ownerStatusFilter) && text.indexOf(search) !== -1;
            });

            var totalPages = Math.max(1, Math.ceil(filtered.length / appState.ownerOrdersPageSize));
            if (appState.ownerOrdersPage > totalPages) appState.ownerOrdersPage = totalPages;
            var start = (appState.ownerOrdersPage - 1) * appState.ownerOrdersPageSize;
            var paged = filtered.slice(start, start + appState.ownerOrdersPageSize);

            if (paged.length === 0) {
                list.innerHTML = '<p class="empty-row">No orders here right now.</p>';
            } else {
                var html = '';
                paged.forEach(function(o) {
                    var options = o.allowed_statuses.map(function(s) {
                        return '<option value="' + s + '"' + (s === o.status ? ' selected' : '') + '>' + capitalize(s) + '</option>';
                    }).join('');
                    html += '<article class="admin-order">' +
                        '<div class="admin-order-id"><strong>#' + o.order_id + '</strong><span>' + formatDate(o.created_at) + '</span></div>' +
                        '<div><strong>' + escapeHtml(o.customer_name) + '</strong><p>' + ORDER_TYPE_LABELS[o.order_type] + ' · ' + o.item_count + ' items' + (o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : '') + '</p></div>' +
                        '<div><p>' + (o.notes ? '“' + escapeHtml(o.notes) + '”' : '') + '</p><button class="link-button" onclick="viewOrderLineItems(' + o.order_id + ')">View items</button></div>' +
                        '<strong>' + peso(o.total_amount) + '</strong>' +
                        '<select class="status-select status-' + o.status + '" onchange="updateOrderStatus(' + o.order_id + ', this.value)">' + options + '</select>' +
                    '</article>';
                });
                list.innerHTML = html;
            }

            renderPagination('owner-orders-pagination', appState.ownerOrdersPage, totalPages, function(p) {
                appState.ownerOrdersPage = p;
                renderOwnerOrders();
            });
        }

        function updateOrderStatus(orderId, status) {
            api('update_order_status', { order_id: orderId, status: status })
                .then(function() {
                    showFlash('Order #' + orderId + ' is now ' + status + '.', 'success');
                    loadOwnerDashboard();
                    loadCustomers();
                })
                .catch(function(err) {
                    showFlash(err.message, 'error');
                    loadOwnerDashboard();
                });
        }

        function loadVendorOrders() {
            if (!isVendor()) return;
            var list = document.getElementById('vendor-orders-list');
            var count = document.getElementById('vendor-orders-count');
            if (appState.user.status !== 'active') {
                count.textContent = '';
                list.innerHTML = '<p class="empty-row">Your vendor account is waiting for the owner&#39;s approval. Orders will appear here once approved.</p>';
                document.getElementById('nav-vendor-open').textContent = '';
                return;
            }
            api('vendor_orders')
                .then(function(data) {
                    appState.vendorOrders = data.orders;
                    var open = appState.vendorOrders.filter(function(o) { return ['pending', 'preparing', 'ready'].indexOf(o.status) !== -1; }).length;
                    document.getElementById('nav-vendor-open').textContent = open || '';
                    renderVendorOrders();
                })
                .catch(function(err) {
                    list.innerHTML = '<p class="empty-row">' + escapeHtml(err.message) + '</p>';
                });
        }

        function renderVendorOrders() {
            var list = document.getElementById('vendor-orders-list');
            var search = document.getElementById('vendor-order-search').value.toLowerCase().trim();
            var orders = appState.vendorOrders.filter(function(o) {
                var text = ('#' + o.order_id + ' ' + o.customer_name).toLowerCase();
                return text.indexOf(search) !== -1;
            });
            var open = appState.vendorOrders.filter(function(o) { return ['pending', 'preparing', 'ready'].indexOf(o.status) !== -1; }).length;
            document.getElementById('vendor-orders-count').textContent = open + ' open - ' + appState.vendorOrders.length + ' total';
            if (orders.length === 0) {
                list.innerHTML = '<p class="empty-row">No customer orders found.</p>';
                return;
            }
            var html = '';
            orders.forEach(function(o) {
                var vendorTransitions = {
                    pending: ['preparing'],
                    preparing: ['completed'],
                    ready: ['completed']
                }[o.status] || [];
                var statusOptions = [o.status].concat(vendorTransitions).map(function(status) {
                    var label = status === 'completed' ? 'Done' : capitalize(status);
                    return '<option value="' + status + '"' + (status === o.status ? ' selected' : '') + '>' + label + '</option>';
                }).join('');
                var statusControl = vendorTransitions.length
                    ? '<select class="status-select status-' + o.status + '" aria-label="Change order #' + o.order_id + ' status" onchange="updateVendorOrderStatus(' + o.order_id + ', this.value, this)">' + statusOptions + '</select>'
                    : '<span class="status-pill status-' + o.status + '">' + (o.status === 'completed' ? 'Done' : capitalize(o.status)) + '</span>';
                html += '<article class="admin-order vendor-order">' +
                    '<div class="admin-order-id"><strong>#' + o.order_id + '</strong><span>' + formatDate(o.created_at) + '</span></div>' +
                    '<div><strong>' + escapeHtml(o.customer_name) + '</strong><p>' + ORDER_TYPE_LABELS[o.order_type] + ' - ' + o.item_count + ' items' + (o.customer_phone ? ' - ' + escapeHtml(o.customer_phone) : '') + '</p></div>' +
                    '<div><p>' + (o.notes ? '&quot;' + escapeHtml(o.notes) + '&quot;' : '') + '</p><button class="link-button" onclick="viewOrderLineItems(' + o.order_id + ')">View items</button></div>' +
                    '<strong>' + peso(o.total_amount) + '</strong>' +
                    '<div class="vendor-order-actions">' + statusControl + '</div>' +
                '</article>';
            });
            list.innerHTML = html;
        }

        function updateVendorOrderStatus(orderId, status, select) {
            if (select) select.disabled = true;
            api('update_order_status', { order_id: orderId, status: status })
                .then(function() {
                    showFlash('Order #' + orderId + ' is now ' + (status === 'completed' ? 'done' : status) + '.', 'success');
                    loadVendorOrders();
                })
                .catch(function(err) {
                    showFlash(err.message, 'error');
                    loadVendorOrders();
                });
        }

        // ------------------------------------------------------------
        // Menu manager: the owner and approved vendors share one menu
        // ------------------------------------------------------------
        function loadManageProducts() {
            if (!isOwner() && !isVendor()) return;
            api('manage_products')
                .then(function(data) {
                    appState.manageProducts = data.products;
                    renderManageMenu();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function findManagedProduct(productId) {
            return appState.manageProducts.find(function(p) { return p.product_id === productId; });
        }

        function renderManageMenu() {
            var list = document.getElementById('owner-menu-list');
            var products = appState.manageProducts;
            var editable = canEditMenu();
            document.getElementById('owner-menu-count').textContent = plural(products.length, 'dish', 'dishes');

            if (products.length === 0) {
                list.innerHTML = '<p class="empty-row">No dishes yet. Add the first one with “Add dish”.</p>';
                return;
            }

            var html = '';
            products.forEach(function(p) {
                var history = 'Added by ' + escapeHtml(p.created_by_name || 'unknown') +
                    (p.updated_by_name && p.updated_by_name !== p.created_by_name ? ' · last edited by ' + escapeHtml(p.updated_by_name) : '');
                var availability = '<span class="availability ' + (p.is_available ? 'on' : 'off') + '">' + (p.is_available ? 'Available' : 'Sold out') + '</span>';
                html += '<article class="admin-order menu-row' + (p.is_available ? '' : ' is-sold-out') + '">' +
                    '<img src="' + escapeHtml(productImage(p)) + '" alt="">' +
                    '<div><strong>' + escapeHtml(p.name) + '</strong><p>' + escapeHtml(p.category_name) + ' · ' + escapeHtml(p.unit) + ' · ' + p.total_sold + ' sold<br>' + history + '</p></div>' +
                    '<strong>' + peso(p.price) + '</strong>' +
                    (editable
                        ? '<button class="availability ' + (p.is_available ? 'on' : 'off') + '" onclick="toggleProduct(' + p.product_id + ')" title="Click to toggle">' + (p.is_available ? 'Available' : 'Sold out') + '</button>' +
                          '<div class="row-actions">' +
                              '<button class="button button-light button-small" onclick="openProductModal(' + p.product_id + ')">Edit</button>' +
                              '<button class="link-button" onclick="deleteProduct(' + p.product_id + ')">Remove</button>' +
                          '</div>'
                        : availability + '<div></div>') +
                '</article>';
            });
            list.innerHTML = html;
        }

        function openProductModal(productId) {
            if (!canEditMenu()) return;
            var form = document.getElementById('product-form');
            var fields = form.elements;
            var preview = document.getElementById('product-form-preview');
            var p = findManagedProduct(productId);
            form.reset();
            form.querySelector('.form-errors').style.display = 'none';

            fields['category_id'].innerHTML = appState.categories.map(function(c) {
                return '<option value="' + c.category_id + '">' + escapeHtml(c.name) + '</option>';
            }).join('');
            fields['product_id'].value = p ? p.product_id : 0;

            if (p) {
                fields['name'].value = p.name;
                fields['category_id'].value = p.category_id;
                fields['price'].value = p.price;
                fields['unit'].value = p.unit;
                fields['description'].value = p.description || '';
                fields['is_available'].value = p.is_available ? '1' : '0';
                preview.src = productImage(p);
                preview.style.display = '';
            } else {
                preview.style.display = 'none';
            }
            document.getElementById('product-modal-title').innerHTML = p ? 'Edit <i>' + escapeHtml(p.name) + '.</i>' : 'Add <i>a dish.</i>';
            openModal('productModal');
        }

        function submitProduct(event) {
            event.preventDefault();
            var form = event.target;
            var errorEl = form.querySelector('.form-errors');
            var btn = document.getElementById('product-form-submit');
            errorEl.style.display = 'none';
            btn.disabled = true;

            api('save_product', new FormData(form))
                .then(function(data) {
                    closeModal('productModal');
                    showFlash(data.message, 'success');
                    loadManageProducts();
                    loadMenu();
                })
                .catch(function(err) {
                    errorEl.textContent = err.message;
                    errorEl.style.display = 'block';
                })
                .then(function() { btn.disabled = false; });
        }

        function toggleProduct(productId) {
            api('toggle_product', { product_id: productId })
                .then(function() {
                    loadManageProducts();
                    loadMenu();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function deleteProduct(productId) {
            var p = findManagedProduct(productId);
            if (!p || !confirm('Remove ' + p.name + ' from the menu?')) return;
            api('delete_product', { product_id: productId })
                .then(function(data) {
                    showFlash(data.message, 'success');
                    loadManageProducts();
                    loadMenu();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        // ------------------------------------------------------------
        // Owner: vendors
        // ------------------------------------------------------------
        function loadOwnerVendors() {
            if (!isOwner()) return;
            api('vendors')
                .then(function(data) {
                    appState.ownerVendors = data.vendors;
                    var pending = data.vendors.filter(function(v) { return v.status === 'pending'; }).length;
                    document.getElementById('nav-pending-vendors').textContent = pending || '';
                    renderOwnerVendors();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function renderOwnerVendors() {
            var list = document.getElementById('owner-vendors-list');
            document.getElementById('owner-vendor-count').textContent = plural(appState.ownerVendors.length, 'account', 'accounts');
            var html = '';
            appState.ownerVendors.forEach(function(v) {
                var actions = '';
                if (v.status !== 'active') actions += '<button class="button button-dark button-small" onclick="setVendorStatus(' + v.user_id + ', \'active\')">' + (v.status === 'pending' ? 'Approve' : 'Reactivate') + '</button>';
                if (v.status !== 'suspended') actions += '<button class="link-button" onclick="setVendorStatus(' + v.user_id + ', \'suspended\')">' + (v.status === 'pending' ? 'Decline' : 'Suspend') + '</button>';
                var label = v.status === 'active' ? 'approved' : v.status;

                html += '<article class="admin-order vendor-row">' +
                    '<div class="admin-order-id"><strong>' + escapeHtml(v.full_name) + '</strong><span>Joined ' + formatDate(v.created_at, true) + '</span></div>' +
                    '<div><p>' + escapeHtml(v.email) + (v.phone ? '<br>' + escapeHtml(v.phone) : '') + '</p></div>' +
                    '<div><span class="status-pill status-' + label + '">' + capitalize(label) + '</span><p>' + plural(v.dishes_added, 'dish', 'dishes') + ' added' + (v.last_menu_edit ? ' · last edit ' + formatDate(v.last_menu_edit) : '') + '</p></div>' +
                    '<div class="row-actions">' + actions + '</div>' +
                '</article>';
            });
            list.innerHTML = html || '<p class="empty-row">No vendor accounts yet. Staff can sign up with “Work at Gigi\'s”.</p>';
        }

        function setVendorStatus(userId, status) {
            var v = appState.ownerVendors.find(function(x) { return x.user_id === userId; });
            if (status === 'suspended' && !confirm(v.full_name + ' will no longer be able to sign in or change the menu. Continue?')) return;
            api('set_vendor_status', { user_id: userId, status: status })
                .then(function() {
                    showFlash(v.full_name + (status === 'active' ? ' can now manage the menu.' : ' is suspended.'), 'success');
                    loadOwnerVendors();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        // ------------------------------------------------------------
        // Owner: customers
        // ------------------------------------------------------------
        function loadCustomers() {
            if (!isOwner()) return;
            api('customers')
                .then(function(data) {
                    appState.customers = data.customers;
                    renderCustomers();
                })
                .catch(function(err) { showFlash(err.message, 'error'); });
        }

        function renderCustomers() {
            var list = document.getElementById('owner-customers-list');
            document.getElementById('owner-customer-count').textContent = appState.customers.length + ' accounts';
            if (appState.customers.length === 0) {
                list.innerHTML = '<p class="empty-row">No customer accounts yet.</p>';
                return;
            }
            var html = '';
            appState.customers.forEach(function(c) {
                html += '<article class="admin-order customer-row">' +
                    '<div class="admin-order-id"><strong>' + escapeHtml(c.full_name) + '</strong><span>Joined ' + formatDate(c.created_at, true) + '</span></div>' +
                    '<div><p>' + escapeHtml(c.email) + (c.phone ? '<br>' + escapeHtml(c.phone) : '') + '</p></div>' +
                    '<div><p>' + c.order_count + ' orders' + (c.last_order_at ? '<br>Last: ' + formatDate(c.last_order_at) : '') + '</p></div>' +
                    '<strong>' + peso(c.total_spent) + '</strong>' +
                '</article>';
            });
            list.innerHTML = html;
        }

        // ------------------------------------------------------------
        // Order line items (customer: own orders, owner: any)
        // ------------------------------------------------------------
        function viewOrderLineItems(orderId) {
            var loadingEl = document.getElementById('order-details-loading');
            var contentEl = document.getElementById('order-details-content');

            document.getElementById('order-details-title').innerHTML = 'Order <i>#' + orderId + '</i>';
            document.getElementById('order-details-eyebrow').textContent = 'Order details';
            loadingEl.textContent = 'Retrieving order details...';
            loadingEl.style.display = 'block';
            contentEl.style.display = 'none';
            openModal('orderDetailsModal');

            api('order_details&order_id=' + orderId)
                .then(function(data) {
                    var o = data.order;
                    loadingEl.style.display = 'none';
                    contentEl.style.display = 'block';
                    document.getElementById('order-details-eyebrow').textContent = o.customer_name + ' · ' + formatDate(o.created_at) + ' · ' + capitalize(o.status);

                    var html = '';
                    data.items.forEach(function(item) {
                        html += '<div class="order-item">' +
                            '<img src="' + escapeHtml(productImage(item)) + '" alt="' + escapeHtml(item.name) + '">' +
                            '<div class="order-item-main">' +
                                '<h3>' + escapeHtml(item.name) + '</h3>' +
                                '<p>' + escapeHtml(item.unit) + ' · ' + peso(item.unit_price) + ' each</p>' +
                            '</div>' +
                            '<span class="line-qty">× ' + item.quantity + '</span>' +
                            '<strong>' + peso(item.subtotal) + '</strong>' +
                        '</div>';
                    });
                    document.getElementById('order-details-list').innerHTML = html || '<p class="empty-row">No items recorded.</p>';
                    document.getElementById('order-details-type').textContent = ORDER_TYPE_LABELS[o.order_type];
                    document.getElementById('order-details-notes-row').style.display = o.notes ? '' : 'none';
                    document.getElementById('order-details-notes').textContent = o.notes || '';
                    document.getElementById('order-details-qty').textContent = o.item_count + ' items';
                    document.getElementById('order-details-total').textContent = peso(o.total_amount);
                })
                .catch(function(err) { loadingEl.textContent = err.message; });
        }

        // ------------------------------------------------------------
        // UI helpers
        // ------------------------------------------------------------
        function openModal(id) {
            document.getElementById(id).classList.add('open');
            document.body.style.overflow = 'hidden';
        }

        function closeModal(id) {
            document.getElementById(id).classList.remove('open');
            if (!document.querySelector('.modal-overlay.open')) document.body.style.overflow = '';
        }

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.open').forEach(function(m) { closeModal(m.id); });
            }
        });

        var flashTimer = null;
        function showFlash(message, type) {
            var el = document.getElementById('flash-message');
            el.className = 'flash ' + (type || 'success');
            el.textContent = message;
            el.style.display = 'block';
            clearTimeout(flashTimer);
            flashTimer = setTimeout(function() { el.style.display = 'none'; }, 3500);
        }

        // Tabs are guarded by role: customers and owners only see their own areas
        var TAB_ROLES = {
            'my-orders': ['customer'],
            'owner-orders': ['owner'],
            'vendor-orders': ['vendor'],
            'owner-vendors': ['owner'],
            'owner-customers': ['owner'],
            'manage-menu': ['owner', 'vendor']
        };

        function switchNavTab(tabId, forceAuth) {
            var allowed = TAB_ROLES[tabId];
            var role = appState.user ? appState.user.role : 'guest';
            if (allowed && allowed.indexOf(role) === -1) tabId = appState.user ? 'catalog' : 'auth';
            if (tabId === 'auth' && appState.user && !forceAuth) tabId = 'catalog';
            if (tabId !== 'auth') clearPendingVerificationEmail();

            appState.activeTab = tabId;
            document.querySelectorAll('.tab-link').forEach(function(btn) {
                btn.classList.toggle('active', btn.dataset.tab === tabId);
            });
            document.querySelectorAll('.tab-view').forEach(function(section) {
                section.classList.toggle('active', section.id === 'tab-' + tabId);
            });
            if (history.replaceState) history.replaceState(null, '', tabId === 'catalog' ? location.pathname : '#' + tabId);
            window.scrollTo(0, 0);

            if (tabId === 'my-orders') loadMyOrders();
            if (tabId === 'owner-orders') loadOwnerDashboard();
            if (tabId === 'vendor-orders') {
                refreshVendorStatus();
                loadVendorOrders();
            }
            if (tabId === 'owner-customers') loadCustomers();
            if (tabId === 'owner-vendors') loadOwnerVendors();
            if (tabId === 'manage-menu') {
                refreshVendorStatus();
                loadManageProducts();
            }
        }

        // Picks up the owner's approval (or suspension) without signing out
        function refreshVendorStatus() {
            if (!isVendor()) return;
            api('me')
                .then(function(data) {
                    if (!data.user) {
                        setUser(null);
                        switchNavTab('auth');
                        showFlash('Your vendor account was suspended. Please talk to Gigi.', 'error');
                    } else if (data.user.status !== appState.user.status) {
                        appState.user = data.user;
                        document.body.classList.toggle('can-edit-menu', canEditMenu());
                        renderAccountNotice();
                        renderManageMenu();
                        loadVendorOrders();
                        if (canEditMenu()) showFlash('Your account is approved. You can now manage the menu.', 'success');
                    }
                })
                .catch(function() {});
        }

        // Keep the kitchen view fresh while an owner has it open
        setInterval(function() {
            if (appState.activeTab === 'owner-orders' && !document.querySelector('.modal-overlay.open')) loadOwnerDashboard();
            if (appState.activeTab === 'vendor-orders' && !document.querySelector('.modal-overlay.open')) {
                refreshVendorStatus();
                loadVendorOrders();
            }
            if (appState.activeTab === 'my-orders') loadMyOrders();
            if (appState.activeTab === 'manage-menu') refreshVendorStatus();
        }, 30000);

        function renderPagination(containerId, currentPage, totalPages, onPageClick) {
            var container = document.getElementById(containerId);
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }

            var pages = [];
            if (totalPages <= 7) {
                for (var i = 1; i <= totalPages; i++) pages.push(i);
            } else if (currentPage <= 4) {
                pages = [1, 2, 3, 4, 5, '...', totalPages];
            } else if (currentPage >= totalPages - 3) {
                pages = [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
            } else {
                pages = [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
            }

            var html = '<button data-page="' + (currentPage - 1) + '"' + (currentPage === 1 ? ' disabled' : '') + '>← Prev</button>';
            pages.forEach(function(p) {
                html += p === '...' ? '<span>…</span>'
                    : '<button data-page="' + p + '" class="' + (p === currentPage ? 'active' : '') + '">' + p + '</button>';
            });
            html += '<button data-page="' + (currentPage + 1) + '"' + (currentPage === totalPages ? ' disabled' : '') + '>Next →</button>';
            container.innerHTML = html;

            container.querySelectorAll('button[data-page]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var target = parseInt(this.dataset.page, 10);
                    if (target >= 1 && target <= totalPages && target !== currentPage) onPageClick(target);
                });
            });
        }

        function findProduct(productId) {
            return appState.products.find(function(p) { return p.product_id === productId; });
        }

        function productImage(p) {
            return p.image || 'IMAGES/menu/placeholder.svg';
        }

        function peso(amount, decimals) {
            var d = decimals === undefined ? 2 : decimals;
            return '₱' + Number(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: d, maximumFractionDigits: d });
        }

        function statusPill(status) {
            return '<span class="status-pill status-' + status + '">' + capitalize(status) + '</span>';
        }

        function plural(n, one, many) {
            return n + ' ' + (n === 1 ? one : many);
        }

        function capitalize(s) {
            return s.charAt(0).toUpperCase() + s.slice(1);
        }

        // MySQL DATETIME ("2026-10-26 13:08:14") to "Oct 26, 1:08 PM"
        function formatDate(value, dateOnly) {
            if (!value) return '';
            var d = new Date(value.replace(' ', 'T'));
            var opts = dateOnly ? { month: 'short', day: 'numeric', year: 'numeric' }
                : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
            return d.toLocaleString('en-US', opts);
        }

        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        document.addEventListener('DOMContentLoaded', initApp);
