const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ⚠️ Apna token yahan rakho
// Render.com pe environment variable me
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Firebase Admin SDK init
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({
  credential: admin.credential.cert(
    serviceAccount
  )
});
const db = admin.firestore();

// ══════════════════════════════
// SEND TELEGRAM MESSAGE
// ══════════════════════════════
async function sendTelegram(
  chatId, 
  message, 
  keyboard = null
) {
  const data = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML'
  };
  if (keyboard) {
    data.reply_markup = {
      inline_keyboard: keyboard
    };
  }
  await axios.post(
    `${BOT_URL}/sendMessage`, 
    data
  );
}

// ══════════════════════════════
// WEBHOOK - Receive Bot Messages
// ══════════════════════════════
app.post('/webhook', async (req, res) => {
  const update = req.body;
  
  try {
    // Handle callback (button clicks)
    if (update.callback_query) {
      await handleCallback(
        update.callback_query
      );
    }
    // Handle text messages
    else if (update.message?.text) {
      await handleMessage(update.message);
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
  
  res.json({ ok: true });
});

// ══════════════════════════════
// HANDLE MESSAGES
// ══════════════════════════════
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Only respond to admin
  if (chatId.toString() !== ADMIN_CHAT_ID) {
    await sendTelegram(
      chatId, 
      '❌ Unauthorized!'
    );
    return;
  }

  if (text === '/start') {
    await sendTelegram(chatId, 
      '👑 <b>VCEarn Admin Bot</b>\n\n' +
      'Commands:\n' +
      '/pending - Pending withdrawals\n' +
      '/stats - App statistics\n' +
      '/users - Total users\n'
    );
  }
  
  else if (text === '/pending') {
    await showPendingWithdrawals(chatId);
  }
  
  else if (text === '/stats') {
    await showStats(chatId);
  }
  
  else if (text === '/users') {
    await showUsers(chatId);
  }
}

// ══════════════════════════════
// SHOW PENDING WITHDRAWALS
// ══════════════════════════════
async function showPendingWithdrawals(chatId) {
  const snap = await db
    .collection('withdrawals')
    .where('status', '==', 'Pending')
    .orderBy('requestTime', 'desc')
    .limit(10)
    .get();

  if (snap.empty) {
    await sendTelegram(
      chatId, 
      '✅ No pending withdrawals!'
    );
    return;
  }

  for (const doc of snap.docs) {
    const w = doc.data();
    const date = w.requestTime
      ?.toDate()
      ?.toLocaleString('en-IN') 
      || 'N/A';

    const msg = 
      `🔔 <b>Withdrawal Request</b>\n\n` +
      `👤 Name: ${w.userName || 'N/A'}\n` +
      `📱 Phone: ${w.userPhone || 'N/A'}\n` +
      `💰 Amount: ₹${w.amount}\n` +
      `📋 Method: ${w.method}\n` +
      `💳 UPI/ID: ${w.upiId || 'Gift Card'}\n` +
      `📅 Time: ${date}\n` +
      `🆔 ID: ${doc.id}`;

    const keyboard = [
      [
        {
          text: '✅ Approve UPI',
          callback_data: `approve_${doc.id}`
        }
      ],
      [
        {
          text: '🎁 Send Gift Code',
          callback_data: `gift_${doc.id}`
        }
      ],
      [
        {
          text: '❌ Reject',
          callback_data: `reject_${doc.id}`
        }
      ]
    ];

    await sendTelegram(chatId, msg, keyboard);
  }
}

// ══════════════════════════════
// HANDLE BUTTON CALLBACKS
// ══════════════════════════════
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const msgId = cb.message.message_id;

  // Only admin
  if (chatId.toString() !== ADMIN_CHAT_ID) {
    return;
  }

  // Approve UPI
  if (data.startsWith('approve_')) {
    const withdrawalId = data.replace(
      'approve_', ''
    );
    
    // Ask for TXN ID
    await sendTelegram(chatId,
      `💳 Enter TXN ID for withdrawal:\n` +
      `ID: ${withdrawalId}\n\n` +
      `Reply: /txn_${withdrawalId}_TXNID123`
    );
  }

  // Gift Card
  else if (data.startsWith('gift_')) {
    const withdrawalId = data.replace(
      'gift_', ''
    );
    
    await sendTelegram(chatId,
      `🎁 Enter Gift Card Code:\n` +
      `ID: ${withdrawalId}\n\n` +
      `Reply: /gift_${withdrawalId}_CODE123`
    );
  }

  // Reject
  else if (data.startsWith('reject_')) {
    const withdrawalId = data.replace(
      'reject_', ''
    );
    await rejectWithdrawal(
      chatId, 
      withdrawalId
    );
  }

  // Process TXN ID
  // Format: /txn_WITHDRAWALID_TXNID
  else if (data.startsWith('txn_')) {
    const parts = data.split('_');
    const withdrawalId = parts[1];
    const txnId = parts[2];
    await approveUPI(
      chatId, 
      withdrawalId, 
      txnId
    );
  }
}

// Handle /txn_ and /gift_ text commands
app.post('/webhook', async (req, res) => {
  // Already handled above
});

// ══════════════════════════════
// APPROVE UPI WITHDRAWAL
// ══════════════════════════════
async function approveUPI(
  chatId, 
  withdrawalId, 
  txnId
) {
  try {
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    
    const doc = await docRef.get();
    if (!doc.exists) {
      await sendTelegram(
        chatId, 
        '❌ Withdrawal not found!'
      );
      return;
    }
    
    const w = doc.data();
    
    // Update withdrawal status
    await docRef.update({
      status: 'Complete',
      txnId: txnId,
      completeTime: 
        admin.firestore.FieldValue
          .serverTimestamp()
    });
    
    // Update user totalWithdrawn
    await db
      .collection('users')
      .doc(w.userId)
      .update({
        totalWithdrawn: 
          admin.firestore.FieldValue
            .increment(w.amount)
      });
    
    await sendTelegram(chatId,
      `✅ <b>Approved!</b>\n\n` +
      `👤 ${w.userName}\n` +
      `💰 ₹${w.amount}\n` +
      `🔖 TXN: ${txnId}`
    );
    
    console.log(
      `Approved: ${withdrawalId}`
    );
  } catch (e) {
    await sendTelegram(
      chatId, 
      `❌ Error: ${e.message}`
    );
  }
}

// ══════════════════════════════
// SEND GIFT CODE
// ══════════════════════════════
async function sendGiftCode(
  chatId, 
  withdrawalId, 
  giftCode
) {
  try {
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    
    const doc = await docRef.get();
    if (!doc.exists) {
      await sendTelegram(
        chatId, 
        '❌ Not found!'
      );
      return;
    }
    
    const w = doc.data();
    
    await docRef.update({
      status: 'Complete',
      giftCode: giftCode,
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });
    
    await db
      .collection('users')
      .doc(w.userId)
      .update({
        totalWithdrawn:
          admin.firestore.FieldValue
            .increment(w.amount)
      });
    
    await sendTelegram(chatId,
      `✅ <b>Gift Code Sent!</b>\n\n` +
      `👤 ${w.userName}\n` +
      `💰 ₹${w.amount}\n` +
      `🎁 Code: ${giftCode}`
    );
  } catch (e) {
    await sendTelegram(
      chatId, 
      `❌ Error: ${e.message}`
    );
  }
}

// ══════════════════════════════
// REJECT WITHDRAWAL
// ══════════════════════════════
async function rejectWithdrawal(
  chatId, 
  withdrawalId
) {
  try {
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    
    const doc = await docRef.get();
    const w = doc.data();
    
    // Refund tokens to user
    await db
      .collection('users')
      .doc(w.userId)
      .update({
        tokens: 
          admin.firestore.FieldValue
            .increment(
              w.amount === 20 ? 200 :
              w.amount === 50 ? 500 : 1000
            )
      });
    
    await docRef.update({
      status: 'Rejected',
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });
    
    await sendTelegram(chatId,
      `❌ <b>Rejected!</b>\n\n` +
      `👤 ${w.userName}\n` +
      `💰 ₹${w.amount} refunded`
    );
  } catch (e) {
    await sendTelegram(
      chatId, 
      `❌ Error: ${e.message}`
    );
  }
}

// ══════════════════════════════
// SHOW STATS
// ══════════════════════════════
async function showStats(chatId) {
  const users = await db
    .collection('users')
    .count()
    .get();
    
  const pending = await db
    .collection('withdrawals')
    .where('status', '==', 'Pending')
    .count()
    .get();
    
  const completed = await db
    .collection('withdrawals')
    .where('status', '==', 'Complete')
    .count()
    .get();

  await sendTelegram(chatId,
    `📊 <b>VCEarn Stats</b>\n\n` +
    `👥 Total Users: ${users.data().count}\n` +
    `⏳ Pending: ${pending.data().count}\n` +
    `✅ Completed: ${completed.data().count}`
  );
}

// ══════════════════════════════
// NEW WITHDRAWAL NOTIFICATION
// This endpoint called from Android app
// ══════════════════════════════
app.post('/notify-withdrawal', 
  async (req, res) => {
    const { 
      userName, 
      amount, 
      method, 
      upiId, 
      withdrawalId 
    } = req.body;

    const msg = 
      `🔔 <b>NEW WITHDRAWAL!</b>\n\n` +
      `👤 ${userName}\n` +
      `💰 ₹${amount}\n` +
      `📋 ${method}\n` +
      `💳 ${upiId || 'Gift Card'}\n` +
      `🆔 ${withdrawalId}`;

    const keyboard = [[
      {
        text: '✅ Process Now',
        callback_data: 
          `approve_${withdrawalId}`
      },
      {
        text: '❌ Reject',
        callback_data: 
          `reject_${withdrawalId}`
      }
    ]];

    await sendTelegram(
      ADMIN_CHAT_ID, 
      msg, 
      keyboard
    );
    
    res.json({ ok: true });
  }
);

// ══════════════════════════════
// START SERVER
// ══════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: ${PORT}`);
});
