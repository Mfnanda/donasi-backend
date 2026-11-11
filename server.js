const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2');
const midtransClient = require('midtrans-client'); // Modul baru Midtrans

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'donasi_ofu'
});

// Konfigurasi Midtrans Sandbox
let snap = new midtransClient.Snap({
  isProduction : false,
  serverKey : 'SB-Mid-server-vDhqAPXiNGgm.mdhe7Dh~ZDY' // <-- GANTI DENGAN SERVER KEY MIDTRANS KAMU
});

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

app.post('/api/create-transaction', (req, res) => {
  const { username, jenis_donasi, nominal, pesan } = req.body;
  const transaction_id = 'OFU-' + Date.now();

  const query = "INSERT INTO transactions (transaction_id, username, jenis_donasi, nominal, pesan, status) VALUES (?, ?, ?, ?, ?, 'PENDING')";
  
  db.query(query, [transaction_id, username, jenis_donasi, nominal, pesan], (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ error: 'Gagal menyimpan transaksi' });
    }
    
    // Meminta token pembayaran (Snap Token) ke Midtrans
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
          // Kirim token Midtrans ke Frontend React
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

// Endpoint untuk menerima notifikasi otomatis dari Midtrans (Webhook)
app.post('/api/midtrans-notification', (req, res) => {
  let notificationJson = req.body;

  snap.transaction.notification(notificationJson)
    .then((statusResponse) => {
      let orderId = statusResponse.order_id;
      let transactionStatus = statusResponse.transaction_status;
      let fraudStatus = statusResponse.fraud_status;

      console.log(`Notifikasi masuk! Order ID: ${orderId}. Status: ${transactionStatus}. Fraud: ${fraudStatus}`);

      // Jika pembayaran berhasil (settlement)
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
      
      // Balas ke Midtrans bahwa pesan sudah diterima
      res.status(200).send('OK');
    })
    .catch((e) => {
      console.error("Midtrans Webhook Error:", e);
      res.status(500).send('Error');
    });
});

// Endpoint untuk mengambil riwayat transaksi berdasarkan username Roblox
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

app.listen(port, () => {
  console.log(`Backend server sudah berjalan di http://localhost:${port}`);
});