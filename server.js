const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2');
const midtransClient = require('midtrans-client');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Koneksi ke TiDB Cloud (Cloud) atau Laragon (Lokal)
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'donasi_ofu',
  ssl: process.env.DB_HOST ? { rejectUnauthorized: true } : undefined
});

// Konfigurasi Midtrans
let snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-vDhqAPXiNGgm.mdhe7Dh~ZDY'
});

// Cek status server
app.get('/', (req, res) => {
  res.send('Server Backend Donasi Ozora Berjalan Normal!');
});

// Cek username & avatar Roblox
app.post('/api/roblox-user', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username tidak boleh kosong' });

  try {
    const userResponse = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username],
      excludeBannedUsers: true
    });
    
    const userData = userResponse.data.data;
    if (!userData || userData.length === 0) {
      return res.status(404).json({ error: 'Username Roblox tidak ditemukan' });
    }

    const userId = userData[0].id;
    const displayName = userData[0].displayName;
    const actualUsername = userData[0].name;

    const avatarResponse = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`);
    let avatarUrl = '';
    if (avatarResponse.data.data && avatarResponse.data.data.length > 0) {
      avatarUrl = avatarResponse.data.data[0].imageUrl;
    }

    res.json({ displayName, username: actualUsername, avatarUrl });
  } catch (error) {
    console.error('Error API Roblox:', error.message);
    res.status(500).json({ error: 'Terjadi masalah saat menghubungi server Roblox' });
  }
});

// Buat transaksi baru & generate token Midtrans
app.post('/api/create-transaction', (req, res) => {
  const { username, jenis_donasi, nominal, pesan } = req.body;
  const transaction_id = 'OZORA-' + Date.now();

  const query = "INSERT INTO transactions (transaction_id, username, jenis_donasi, nominal, pesan, status) VALUES (?, ?, ?, ?, ?, 'PENDING')";
  
  db.query(query, [transaction_id, username, jenis_donasi || 'Cash', nominal, pesan], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ error: 'Gagal menyimpan transaksi' });
    }
    
    let parameter = {
      "transaction_details": {
        "order_id": transaction_id,
        "gross_amount": nominal
      },
      "customer_details": {
        "first_name": username,
      }
    };

    snap.createTransaction(parameter)
      .then((transaction) => {
        res.json({ 
          message: 'Transaksi berhasil dibuat', 
          transaction_id: transaction_id,
          token: transaction.token
        });
      })
      .catch((e) => {
        console.error("Midtrans Error:", e);
        res.status(500).json({ error: 'Gagal membuat QRIS Midtrans' });
      });
  });
});

// Webhook notifikasi pembayaran dari Midtrans
app.post('/api/midtrans-notification', (req, res) => {
  let notificationJson = req.body;

  snap.transaction.notification(notificationJson)
    .then((statusResponse) => {
      let orderId = statusResponse.order_id;
      let transactionStatus = statusResponse.transaction_status;
      let fraudStatus = statusResponse.fraud_status;

      console.log(`Notifikasi masuk! Order ID: ${orderId}. Status: ${transactionStatus}. Fraud: ${fraudStatus}`);

      if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
        const query = "UPDATE transactions SET status = 'LUNAS' WHERE transaction_id = ?";
        db.query(query, [orderId], (err, results) => {
          if (err) {
            console.error("Gagal update database:", err);
          } else {
            console.log(`Transaksi ${orderId} berhasil diupdate menjadi LUNAS di database!`);
          }
        });
      } 
      
      res.status(200).send('OK');
    })
    .catch((e) => {
      console.error("Midtrans Webhook Error:", e);
      res.status(500).send('Error');
    });
});

// Ambil riwayat donasi berdasarkan username
app.get('/api/history/:username', (req, res) => {
  const { username } = req.params;
  
  const query = "SELECT transaction_id, jenis_donasi, nominal, pesan, status, created_at FROM transactions WHERE username = ? ORDER BY id DESC";
  
  db.query(query, [username], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ error: 'Gagal mengambil riwayat transaksi' });
    }
    res.json(results);
  });
});

// Endpoint khusus Server Map Roblox untuk mengambil donasi baru
app.get('/api/roblox/donations', (req, res) => {
  const secretKey = req.headers['x-roblox-secret'];
  const validSecret = process.env.ROBLOX_SECRET_KEY || 'ozora_club_rahasia_2026';

  if (secretKey !== validSecret) {
    return res.status(401).json({ error: 'Unauthorized: Secret key salah' });
  }

  const selectQuery = `
    SELECT id, transaction_id, username, nominal, pesan, created_at 
    FROM transactions 
    WHERE status = 'LUNAS' AND is_announced = 0 
    ORDER BY created_at ASC 
    LIMIT 10
  `;

  db.query(selectQuery, (err, rows) => {
    if (err) {
      console.error('Gagal mengambil data donasi Roblox:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (rows.length === 0) {
      return res.json({ success: true, donations: [] });
    }

    const ids = rows.map(row => row.id);
    const updateQuery = `UPDATE transactions SET is_announced = 1 WHERE id IN (?)`;

    db.query(updateQuery, [ids], (updateErr) => {
      if (updateErr) {
        console.error('Gagal update status is_announced:', updateErr);
        return res.status(500).json({ error: 'Gagal memperbarui status pengumuman' });
      }

      res.json({ success: true, donations: rows });
    });
  });
});

app.listen(port, () => {
  console.log(`Backend server sudah berjalan di port ${port}`);
});