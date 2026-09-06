const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const midtransClient = require('midtrans-client');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'xolofox_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

let snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: 'YOUR_MIDTRANS_SERVER_KEY',
    clientKey: 'YOUR_MIDTRANS_CLIENT_KEY'
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'customer')`);
    db.run(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, category TEXT, stock INTEGER, image TEXT, active INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id INTEGER, name TEXT, phone TEXT, address TEXT, city TEXT, postal_code TEXT, total_amount INTEGER, payment_status TEXT DEFAULT 'pending', order_status TEXT DEFAULT 'Pending')`);
    db.run(`CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, product_id INTEGER, quantity INTEGER, price INTEGER)`);

    db.get("SELECT count(*) as count FROM categories", (err, row) => {
        if(row.count === 0) {
            const categories = ['Fashion', 'Skincare', 'Accessories', 'Elektronik'];
            categories.forEach(cat => db.run("INSERT INTO categories (name) VALUES (?)", [cat]));
        }
    });

    db.get("SELECT count(*) as count FROM products", (err, row) => {
        if(row.count === 0) {
            db.run("INSERT INTO products (name, price, category, stock, image) VALUES ('Kemeja Flanel Premium', 150000, 'Fashion', 20, 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=500')");
            db.run("INSERT INTO products (name, price, category, stock, image) VALUES ('Serum Glowing Hydration', 85000, 'Skincare', 15, 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=500')");
            db.run("INSERT INTO products (name, price, category, stock, image) VALUES ('Smartwatch Series X', 450000, 'Elektronik', 10, 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500')");
        }
    });
});

app.post('/api/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role || 'customer';
        db.run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`, [name, email, hashedPassword, userRole], function(err) {
            if (err) return res.status(400).json({ message: "Email sudah terdaftar" });
            res.json({ message: "Registrasi berhasil!" });
        });
    } catch { res.status(500).send(); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: "Email atau password salah" });
        }
        req.session.userId = user.id;
        req.session.role = user.role;
        res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: "Logged out" });
});

app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products WHERE active = 1", [], (err, rows) => {
        res.json(rows);
    });
});

app.post('/api/checkout', (req, res) => {
    const { name, phone, address, city, postal_code, items, total_amount, user_id } = req.body;
    const orderId = 'XOLO-' + Date.now();

    let stockCheck = true;
    let checkedCount = 0;

    items.forEach(item => {
        db.get("SELECT stock, name FROM products WHERE id = ?", [item.id], (err, prod) => {
            checkedCount++;
            if (!prod || prod.stock < item.quantity) stockCheck = false;
            
            if (checkedCount === items.length) {
                if (!stockCheck) return res.status(400).json({ message: "Stok produk tidak mencukupi!" });

                db.run(`INSERT INTO orders (id, user_id, name, phone, address, city, postal_code, total_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [orderId, user_id, name, phone, address, city, postal_code, total_amount], function(err) {
                    
                    items.forEach(it => {
                        db.run(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)`, [orderId, it.id, it.quantity, it.price]);
                        db.run(`UPDATE products SET stock = stock - ? WHERE id = ?`, [it.quantity, it.id]);
                    });

                    let parameter = {
                        "transaction_details": { "order_id": orderId, "gross_amount": total_amount },
                        "credit_card": { "secure": true },
                        "customer_details": { "first_name": name, "phone": phone }
                    };

                    snap.createTransaction(parameter)
                        .then((transaction) => {
                            res.json({ token: transaction.token, orderId: orderId });
                        }).catch((e) => {
                            res.status(500).json({ message: e.message });
                        });
                });
            }
        });
    });
});

app.post('/api/payment-callback', (req, res) => {
    let notificationJson = req.body;
    snap.transaction.notification(notificationJson)
        .then((statusResponse) => {
            let orderId = statusResponse.order_id;
            let transactionStatus = statusResponse.transaction_status;
            let paymentStatus = 'pending';

            if (transactionStatus == 'capture' || transactionStatus == 'settlement') paymentStatus = 'paid';
            else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') paymentStatus = 'failed';

            db.run(`UPDATE orders SET payment_status = ? WHERE id = ?`, [paymentStatus, orderId]);
            res.status(200).send('OK');
        });
});

app.get('/api/admin/dashboard', (req, res) => {
    const stats = {};
    db.get("SELECT COUNT(*) as count FROM users WHERE role='customer'", (err, r) => { stats.users = r.count;
    db.get("SELECT COUNT(*) as count FROM products", (err, r) => { stats.products = r.count;
    db.get("SELECT COUNT(*) as count FROM orders", (err, r) => { stats.orders = r.count;
    db.get("SELECT SUM(total_amount) as total FROM orders WHERE payment_status='paid'", (err, r) => { stats.revenue = r.total || 0;
    db.get("SELECT COUNT(*) as count FROM orders WHERE payment_status='pending'", (err, r) => { stats.pending_payments = r.count;
    db.all("SELECT * FROM orders ORDER BY id DESC", (err, rows) => { stats.order_list = rows;
    db.all("SELECT * FROM products", (err, prods) => { stats.product_list = prods;
        res.json(stats);
    }); }); }); }); }); }); });
});

app.post('/api/admin/product', (req, res) => {
    const { name, price, category, stock, image } = req.body;
    db.run("INSERT INTO products (name, price, category, stock, image) VALUES (?, ?, ?, ?, ?)", [name, price, category, stock, image], () => res.json({status: "success"}));
});
app.put('/api/admin/product/:id', (req, res) => {
    const { name, price, category, stock, active } = req.body;
    db.run("UPDATE products SET name=?, price=?, category=?, stock=?, active=? WHERE id=?", [name, price, category, stock, active, req.params.id], () => res.json({status: "success"}));
});
app.put('/api/admin/order/:id', (req, res) => {
    const { order_status } = req.body;
    db.run("UPDATE orders SET order_status = ? WHERE id = ?", [order_status, req.params.id], () => res.json({status: "success"}));
});

app.listen(3000, () => console.log('Server berjalan di internet lokal http://localhost:3000'));