const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Firebase init
let serviceAccount;
try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );
} catch(e) {
  console.error('Firebase JSON error:', e);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      serviceAccount
    )
  });
}
const db = admin.firestore();

// Send Telegram message
async function sendTelegram(
  chatId, message, keyboard = null
) {
  try {
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
      `${BOT_URL}/sendMessage`, data
    );
  } catch(e) {
    console.error('Send error:', e.message);
  }
}

// Webhook
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  try {
    if (update.callback_query) {
      await handleCallback(
        update.callback_query
      );
    } else if (update.message?.text) {
      await handleMessage(update.message);
    }
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// Handle messages
async function handleMessage(msg) {
  const chatId = msg.chat.id.toString();
  const text = msg.text;

  if (chatId !== ADMIN_CHAT_ID) {
    await sendTelegram(
      chatId, '❌ Unauthorized!'
    );
    return;
  }

  if (text === '/start') {
    await sendTelegram(chatId,
      '👑 <b>VCEarn Admin Bot</b>\n\n' +
      'Commands:\n' +
      '/pending - Pending withdrawals\n' +
      '/stats - App statistics\n' +
      '/users - Total users count'
    );
  }
  else if (text === '/pending') {
    await showPending(chatId);
  }
  else if (text === '/stats') {
    await showStats(chatId);
  }
  else if (text === '/users') {
    await showUsers(chatId);
  }
  else if (text.startsWith('/txn_')) {
    const content = text.replace('/txn_', '');
    const underscoreIndex = content.indexOf('_');
    if (underscoreIndex === -1) {
      await sendTelegram(chatId,
        '❌ Format: /txn_WITHDRAWALID_TXNID'
      );
      return;
    }
    const wId = content.substring(
      0, underscoreIndex
    );
    const txnId = content.substring(
      underscoreIndex + 1
    );
    await approveUPI(chatId, wId, txnId);
  }
  else if (text.startsWith('/code_')) {
    const content = text.replace('/code_', '');
    const underscoreIndex = content.indexOf('_');
    if (underscoreIndex === -1) {
      await sendTelegram(chatId,
        '❌ Format: /code_WITHDRAWALID_CODE'
      );
      return;
    }
    const wId = content.substring(
      0, underscoreIndex
    );
    const code = content.substring(
      underscoreIndex + 1
    );
    await sendGiftCode(chatId, wId, code);
  }
  else {
    await sendTelegram(chatId,
      '❓ Unknown command\n\n' +
      'Available:\n' +
      '/pending\n/stats\n/users'
    );
  }
}

// Show pending withdrawals
async function showPending(chatId) {
  try {
    await sendTelegram(
      chatId, '⏳ Fetching pending...'
    );

    const snap = await db
      .collection('withdrawals')
      .get();

    const pendingDocs = snap.docs.filter(
      doc => doc.data().status === 'Pending'
    );

    if (pendingDocs.length === 0) {
      await sendTelegram(chatId,
        '✅ No pending withdrawals!'
      );
      return;
    }

    await sendTelegram(chatId,
      `📋 Found ${pendingDocs.length} pending`
    );

    for (const doc of pendingDocs) {
      const w = doc.data();
      const msg =
        `🔔 <b>Withdrawal Request</b>\n\n` +
        `👤 Name: ${w.userName || 'N/A'}\n` +
        `💰 Amount: ₹${w.amount || 0}\n` +
        `📋 Method: ${w.method || 'N/A'}\n` +
        `💳 UPI: ${w.upiId || 'Gift Card'}\n` +
        `🆔 ID: <code>${doc.id}</code>\n\n` +
        `<b>To approve UPI payment:</b>\n` +
        `/txn_${doc.id}_TXNID123\n\n` +
        `<b>To send gift card code:</b>\n` +
        `/code_${doc.id}_GIFTCODE\n`;

      const keyboard = [[{
        text: '❌ Reject & Refund',
        callback_data: `reject_${doc.id}`
      }]];

      await sendTelegram(chatId, msg, keyboard);
    }
  } catch(e) {
    console.error('Pending error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Show stats
async function showStats(chatId) {
  try {
    await sendTelegram(
      chatId, '⏳ Fetching stats...'
    );

    const usersSnap = await db
      .collection('users')
      .get();

    const withdrawalsSnap = await db
      .collection('withdrawals')
      .get();

    let pending = 0;
    let completed = 0;
    let rejected = 0;
    let totalAmount = 0;

    withdrawalsSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === 'Pending') pending++;
      if (data.status === 'Complete') {
        completed++;
        totalAmount += (data.amount || 0);
      }
      if (data.status === 'Rejected') rejected++;
    });

    await sendTelegram(chatId,
      `📊 <b>VCEarn Stats</b>\n\n` +
      `👥 Total Users: ${usersSnap.size}\n` +
      `⏳ Pending: ${pending}\n` +
      `✅ Completed: ${completed}\n` +
      `❌ Rejected: ${rejected}\n` +
      `💰 Total Paid: ₹${totalAmount}`
    );
  } catch(e) {
    console.error('Stats error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Show users
async function showUsers(chatId) {
  try {
    await sendTelegram(
      chatId, '⏳ Fetching users...'
    );

    const snap = await db
      .collection('users')
      .get();

    await sendTelegram(chatId,
      `👥 <b>VCEarn Users</b>\n\n` +
      `Total: ${snap.size} users`
    );
  } catch(e) {
    console.error('Users error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Handle callbacks
async function handleCallback(cb) {
  const chatId = cb.message.chat.id.toString();
  const data = cb.data;

  if (chatId !== ADMIN_CHAT_ID) return;

  if (data.startsWith('reject_')) {
    const wId = data.replace('reject_', '');
    await rejectWithdrawal(chatId, wId);
  }
}

// Approve UPI
async function approveUPI(
  chatId, withdrawalId, txnId
) {
  try {
    await sendTelegram(
      chatId, '⏳ Processing approval...'
    );

    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);

    const doc = await docRef.get();

    if (!doc.exists) {
      await sendTelegram(chatId,
        `❌ Withdrawal not found!\nID: ${withdrawalId}`
      );
      return;
    }

    const w = doc.data();

    await docRef.update({
      status: 'Complete',
      txnId: txnId,
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });

    try {
      await db
        .collection('users')
        .doc(w.userId)
        .update({
          totalWithdrawn:
            admin.firestore.FieldValue
              .increment(w.amount || 0)
        });
    } catch(e) {
      console.error('User update error:', e);
    }

    await sendTelegram(chatId,
      `✅ <b>Payment Approved!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `💳 UPI: ${w.upiId}\n` +
      `🔖 TXN ID: ${txnId}`
    );
  } catch(e) {
    console.error('Approve error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Send gift code
async function sendGiftCode(
  chatId, withdrawalId, code
) {
  try {
    await sendTelegram(
      chatId, '⏳ Sending gift code...'
    );

    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);

    const doc = await docRef.get();

    if (!doc.exists) {
      await sendTelegram(chatId,
        `❌ Withdrawal not found!\nID: ${withdrawalId}`
      );
      return;
    }

    const w = doc.data();

    await docRef.update({
      status: 'Complete',
      giftCode: code,
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });

    try {
      await db
        .collection('users')
        .doc(w.userId)
        .update({
          totalWithdrawn:
            admin.firestore.FieldValue
              .increment(w.amount || 0)
        });
    } catch(e) {
      console.error('User update error:', e);
    }

    await sendTelegram(chatId,
      `✅ <b>Gift Code Sent!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `📋 Method: ${w.method}\n` +
      `🎁 Code: <code>${code}</code>`
    );
  } catch(e) {
    console.error('Gift error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Reject withdrawal
async function rejectWithdrawal(
  chatId, withdrawalId
) {
  try {
    await sendTelegram(
      chatId, '⏳ Processing rejection...'
    );

    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);

    const doc = await docRef.get();

    if (!doc.exists) {
      await sendTelegram(chatId,
        `❌ Not found!\nID: ${withdrawalId}`
      );
      return;
    }

    const w = doc.data();

    const refundTokens =
      w.amount === 20 ? 200 :
      w.amount === 50 ? 500 :
      w.amount === 100 ? 1000 : 200;

    await docRef.update({
      status: 'Rejected',
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });

    try {
      await db
        .collection('users')
        .doc(w.userId)
        .update({
          tokens:
            admin.firestore.FieldValue
              .increment(refundTokens)
        });
    } catch(e) {
      console.error('Refund error:', e);
    }

    await sendTelegram(chatId,
      `❌ <b>Withdrawal Rejected!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount} rejected\n` +
      `🪙 ${refundTokens} tokens refunded`
    );
  } catch(e) {
    console.error('Reject error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

// Notify from app
app.post('/notify-withdrawal',
  async (req, res) => {
    try {
      const {
        userName,
        amount,
        method,
        upiId,
        withdrawalId
      } = req.body;

      const msg =
        `🔔 <b>NEW WITHDRAWAL REQUEST!</b>\n\n` +
        `👤 ${userName || 'User'}\n` +
        `💰 ₹${amount}\n` +
        `📋 ${method}\n` +
        `💳 ${upiId || 'Gift Card'}\n` +
        `🆔 <code>${withdrawalId}</code>\n\n` +
        `<b>To approve UPI:</b>\n` +
        `/txn_${withdrawalId}_TXNID\n\n` +
        `<b>To send gift:</b>\n` +
        `/code_${withdrawalId}_CODE`;

      const keyboard = [[{
        text: '❌ Reject & Refund',
        callback_data: `reject_${withdrawalId}`
      }]];

      await sendTelegram(
        ADMIN_CHAT_ID, msg, keyboard
      );

      res.json({ ok: true });
    } catch(e) {
      console.error('Notify error:', e);
      res.json({ ok: false, error: e.message });
    }
  }
);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ VCEarn Bot Running',
    time: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: ${PORT}`);
});
