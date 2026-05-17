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
  console.error('Firebase JSON parse error:', e);
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
    await sendTelegram(chatId, '❌ Unauthorized!');
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
    // Format: /txn_WITHDRAWALID_TXNID
    const parts = text.replace('/txn_','').split('_');
    const wId = parts[0];
    const txnId = parts.slice(1).join('_');
    await approveUPI(chatId, wId, txnId);
  }
  else if (text.startsWith('/code_')) {
    // Format: /code_WITHDRAWALID_GIFTCODE
    const parts = text.replace('/code_','').split('_');
    const wId = parts[0];
    const code = parts.slice(1).join('_');
    await sendGiftCode(chatId, wId, code);
  }
}

// Show pending withdrawals
async function showPending(chatId) {
  try {
    const snap = await db
      .collection('withdrawals')
      .where('status', '==', 'Pending')
      .get();

    if (snap.empty) {
      await sendTelegram(chatId,
        '✅ No pending withdrawals!'
      );
      return;
    }

    for (const doc of snap.docs) {
      const w = doc.data();
      const msg =
        `🔔 <b>Withdrawal Request</b>\n\n` +
        `👤 Name: ${w.userName || 'N/A'}\n` +
        `💰 Amount: ₹${w.amount}\n` +
        `📋 Method: ${w.method}\n` +
        `💳 UPI: ${w.upiId || 'Gift Card'}\n` +
        `🆔 ID: <code>${doc.id}</code>\n\n` +
        `To approve UPI:\n` +
        `/txn_${doc.id}_TXNID123\n\n` +
        `To send gift code:\n` +
        `/code_${doc.id}_GIFTCODE`;

      const keyboard = [[
        {
          text: '❌ Reject',
          callback_data: `reject_${doc.id}`
        }
      ]];

      await sendTelegram(chatId, msg, keyboard);
    }
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
    );
  }
}

// Show stats
async function showStats(chatId) {
  try {
    const usersSnap = await db
      .collection('users')
      .get();
    
    const pendingSnap = await db
      .collection('withdrawals')
      .where('status', '==', 'Pending')
      .get();
    
    const completedSnap = await db
      .collection('withdrawals')
      .where('status', '==', 'Complete')
      .get();

    await sendTelegram(chatId,
      `📊 <b>VCEarn Stats</b>\n\n` +
      `👥 Total Users: ${usersSnap.size}\n` +
      `⏳ Pending: ${pendingSnap.size}\n` +
      `✅ Completed: ${completedSnap.size}`
    );
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
    );
  }
}

// Show users
async function showUsers(chatId) {
  try {
    const snap = await db
      .collection('users')
      .get();
    
    await sendTelegram(chatId,
      `👥 <b>Total Users: ${snap.size}</b>\n\n` +
      `Active accounts in VCEarn`
    );
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
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
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      await sendTelegram(
        chatId, '❌ Not found!'
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

    await db.collection('users')
      .doc(w.userId)
      .update({
        totalWithdrawn:
          admin.firestore.FieldValue
            .increment(w.amount)
      });

    await sendTelegram(chatId,
      `✅ <b>Approved!</b>\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `🔖 TXN: ${txnId}`
    );
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
    );
  }
}

// Send gift code
async function sendGiftCode(
  chatId, withdrawalId, code
) {
  try {
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      await sendTelegram(
        chatId, '❌ Not found!'
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

    await db.collection('users')
      .doc(w.userId)
      .update({
        totalWithdrawn:
          admin.firestore.FieldValue
            .increment(w.amount)
      });

    await sendTelegram(chatId,
      `✅ <b>Gift Code Sent!</b>\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `🎁 Code: ${code}`
    );
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
    );
  }
}

// Reject withdrawal
async function rejectWithdrawal(
  chatId, withdrawalId
) {
  try {
    const docRef = db
      .collection('withdrawals')
      .doc(withdrawalId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      await sendTelegram(
        chatId, '❌ Not found!'
      );
      return;
    }
    const w = doc.data();

    const refundTokens =
      w.amount === 20 ? 200 :
      w.amount === 50 ? 500 : 1000;

    await db.collection('users')
      .doc(w.userId)
      .update({
        tokens:
          admin.firestore.FieldValue
            .increment(refundTokens)
      });

    await docRef.update({
      status: 'Rejected',
      completeTime:
        admin.firestore.FieldValue
          .serverTimestamp()
    });

    await sendTelegram(chatId,
      `❌ <b>Rejected!</b>\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount} tokens refunded`
    );
  } catch(e) {
    await sendTelegram(
      chatId, `❌ Error: ${e.message}`
    );
  }
}

// Notify withdrawal from app
app.post('/notify-withdrawal',
  async (req, res) => {
    try {
      const {
        userName, amount, method,
        upiId, withdrawalId
      } = req.body;

      const msg =
        `🔔 <b>NEW WITHDRAWAL!</b>\n\n` +
        `👤 ${userName}\n` +
        `💰 ₹${amount}\n` +
        `📋 ${method}\n` +
        `💳 ${upiId || 'Gift Card'}\n` +
        `🆔 <code>${withdrawalId}</code>\n\n` +
        `To approve UPI:\n` +
        `/txn_${withdrawalId}_TXNID\n\n` +
        `To send gift:\n` +
        `/code_${withdrawalId}_CODE`;

      const keyboard = [[{
        text: '❌ Reject',
        callback_data: `reject_${withdrawalId}`
      }]];

      await sendTelegram(
        ADMIN_CHAT_ID, msg, keyboard
      );
      res.json({ ok: true });
    } catch(e) {
      console.error(e.message);
      res.json({ ok: false });
    }
  }
);

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'VCEarn Bot Running ✅' 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: ${PORT}`);
});
