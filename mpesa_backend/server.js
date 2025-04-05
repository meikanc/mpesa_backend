require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Create a MySQL connection pool using environment variables
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS
});

// === 1. PAYMENT PROCESSING ENDPOINT ===
app.post('/process_payment', async (req, res) => {
  try {
    const { method, amount, cart, phone } = req.body;

    if (!method || !amount || !cart || cart.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const paymentMethod = method.toLowerCase().trim();
    let formattedPhone = phone?.replace(/\D/g, '');
    if (paymentMethod === 'mpesa') {
      if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
      if (!/^254[17]\d{8}$/.test(formattedPhone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone format' });
      }
    }

    const conn = await db.getConnection();
    await conn.beginTransaction();

    const [orderResult] = await conn.execute(
      `INSERT INTO orders (total_price, status) VALUES (?, ?)`,
      [amount, paymentMethod === 'cash' ? 'pending' : 'processing']
    );
    const orderId = orderResult.insertId;

    // Insert order items (order_id, product_id, quantity, subtotal)
    const orderItemStmt = `INSERT INTO order_items (order_id, product_id, quantity, subtotal) VALUES (?, ?, ?, ?)`;
    for (const item of cart) {
      const subtotal = parseFloat(item.price) * parseInt(item.quantity);
      await conn.execute(orderItemStmt, [orderId, item.id, item.quantity, subtotal]);
    }

    // Create payment record in the payments table
    const transactionId = `ORD${orderId}${Date.now()}`;
    await conn.execute(
      `INSERT INTO payments (order_id, amount, payment_method, phone_number, status, transaction_id) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orderId, amount, paymentMethod, formattedPhone, paymentMethod === 'cash' ? 'pending' : 'initiated', transactionId]
    );

    let checkoutRequestId = null;
    if (paymentMethod === 'mpesa') {
      checkoutRequestId = `MPESA_${Date.now()}_${orderId}`;
      await conn.execute(
        `INSERT INTO mpesa_transactions (order_id, phone, amount, status, checkout_request_id) 
         VALUES (?, ?, ?, 'initiated', ?)`,
        [orderId, formattedPhone, amount, checkoutRequestId]
      );
      await conn.execute(`UPDATE orders SET checkout_request_id = ? WHERE id = ?`, [checkoutRequestId, orderId]);
    }

    await conn.commit();
    conn.release();

    res.json({ success: true, order_id: orderId, transaction_id: transactionId, checkout_request_id: checkoutRequestId });
  } catch (err) {
    console.error('process_payment error:', err);
    res.status(500).json({ success: false, message: 'Server error processing payment' });
  }
});

// === 2. INITIATE MPESA STK PUSH ENDPOINT ===
app.post('/mpesa_initiate', async (req, res) => {
  try {
    const { order_id } = req.body;
    const [rows] = await db.execute(
      `SELECT o.total_price, p.phone_number 
       FROM orders o JOIN payments p ON o.id = p.order_id WHERE o.id = ?`, [order_id]);

    if (!rows.length) return res.status(404).json({ success: false, message: 'Order not found' });

    const { total_price, phone_number } = rows[0];

    // Generate timestamp and password for MPESA
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    // Obtain access token from MPESA
    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64')
      }
    });
    const { access_token } = tokenRes.data;

    // Send STK push request
    const stkRes = await axios.post(process.env.MPESA_STK_PUSH_URL, {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: total_price,
      PartyA: phone_number,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone_number,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'Order_' + order_id,
      TransactionDesc: 'Payment for Order #' + order_id
    }, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({ success: true, message: 'STK push sent successfully', response: stkRes.data });
  } catch (err) {
    console.error('mpesa_initiate error:', err?.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Failed to initiate STK push' });
  }
});

// === 3. MPESA CALLBACK ENDPOINT ===
app.post('/mpesa_callback', async (req, res) => {
  try {
    const callback = req.body;
    const stkCallback = callback?.Body?.stkCallback;
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback || {};

    if (!CheckoutRequestID || ResultCode === undefined) throw new Error('Missing required fields in callback');

    const metadata = {};
    CallbackMetadata?.Item?.forEach(item => {
      metadata[item.Name] = item.Value;
    });

    const conn = await db.getConnection();
    await conn.beginTransaction();

    const [records] = await conn.execute(
      `SELECT mt.order_id, mt.amount FROM mpesa_transactions mt WHERE mt.checkout_request_id = ? FOR UPDATE`,
      [CheckoutRequestID]
    );

    if (!records.length) throw new Error('Transaction not found');
    const { order_id, amount } = records[0];

    if (parseFloat(metadata.Amount) !== parseFloat(amount)) throw new Error('Amount mismatch');

    if (ResultCode === 0) {
      // Successful payment
      await conn.execute(
        `UPDATE mpesa_transactions 
         SET status = 'completed', mpesa_receipt_number = ?, transaction_date = ?, result_code = ?, result_description = ?, updated_at = NOW()
         WHERE checkout_request_id = ?`,
        [metadata.MpesaReceiptNumber, metadata.TransactionDate, ResultCode, ResultDesc, CheckoutRequestID]
      );

      await conn.execute(`UPDATE orders SET status = 'completed', payment_status = 'paid', updated_at = NOW() WHERE id = ?`, [order_id]);

      await conn.execute(`UPDATE payments SET status = 'completed', transaction_reference = ?, payment_reference = ?, updated_at = NOW()
         WHERE order_id = ?`, [metadata.MpesaReceiptNumber, CheckoutRequestID, order_id]);

    } else {
      // Payment failed
      await conn.execute(`UPDATE mpesa_transactions SET status = 'failed', result_description = ? WHERE checkout_request_id = ?`,
        [ResultDesc, CheckoutRequestID]);
      await conn.execute(`UPDATE orders SET status = 'failed', payment_status = 'failed' WHERE id = ?`, [order_id]);
      await conn.execute(`UPDATE payments SET status = 'failed', failure_reason = ? WHERE order_id = ?`, [ResultDesc, order_id]);
    }

    await conn.commit();
    conn.release();

    res.json({ ResultCode: 0, ResultDesc: 'Callback received successfully' });
  } catch (err) {
    console.error('mpesa_callback error:', err.message);
    res.json({ ResultCode: 0, ResultDesc: 'Callback received with issues' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MPESA backend running on port ${PORT}`);
});
