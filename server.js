const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_URL = 'https://vcearn1-default-rtdb.asia-southeast1.firebasedatabase.app';

let serviceAccount;
try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );
} catch(e) {
  console.error('JSON error:', e.message);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DB_URL
  });
}

const db = admin.database();

// Pending TXN/Code input state
const waitingForInput = {};

async function sendTelegram(chatId, message, keyboard = null) {
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
    await axios.post(`${BOT_URL}/sendMessage`, data);
  } catch(e) {
    console.error('Send error:', e.message);
  }
}

app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message?.text) {
      await handleMessage(update.message);
    }
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

async function handleMessage(msg) {
  const chatId = msg.chat.id.toString();
  const text = msg.text;

  if (chatId !== ADMIN_CHAT_ID) {
    await sendTelegram(chatId, '❌ Unauthorized!');
    return;
  }

  // Check if waiting for TXN ID input
  if (waitingForInput[chatId]) {
    const { type, withdrawalId } = waitingForInput[chatId];
    delete waitingForInput[chatId];

    if (type === 'txn') {
      await approveUPI(chatId, withdrawalId, text.trim());
    } else if (type === 'code') {
      await sendGiftCode(chatId, withdrawalId, text.trim());
    }
    return;
  }

  if (text === '/start') {
    await sendTelegram(chatId,
      '👑 <b>VCEarn Admin Bot</b>\n\n' +
      'Commands:\n' +
      '/pending - Pending withdrawals\n' +
      '/stats - App statistics\n' +
      '/users - Total users\n\n' +
      'Use buttons to approve/reject!'
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
  else {
    await sendTelegram(chatId,
      '❓ Unknown command\nUse /start for help'
    );
  }
}

async function showPending(chatId) {
  try {
    await sendTelegram(chatId, '⏳ Fetching pending...');

    const snap = await db.ref('withdrawals').once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, '✅ No withdrawals yet!');
      return;
    }

    const pending = [];
    snap.forEach(child => {
      const w = child.val();
      if (w.status === 'Pending') {
        pending.push({ id: child.key, ...w });
      }
    });

    if (pending.length === 0) {
      await sendTelegram(chatId, '✅ No pending withdrawals!');
      return;
    }

    await sendTelegram(chatId, `📋 Found <b>${pending.length}</b> pending`);

    for (const w of pending) {
      const isUPI = w.method === 'UPI';
      const isGift = w.method === 'Amazon' || w.method === 'Playstore';

      const msg =
        `🔔 <b>Withdrawal Request</b>\n\n` +
        `👤 Name: ${w.userName || 'N/A'}\n` +
        `💰 Amount: ₹${w.amount}\n` +
        `📋 Method: ${w.method}\n` +
        `💳 ${isUPI ? 'UPI: ' + w.upiId : 'Gift Card'}\n` +
        `🆔 ID: <code>${w.id}</code>`;

      // Build keyboard with all buttons
      const keyboard = [];

      if (isUPI) {
        keyboard.push([{
          text: '✅ Approve UPI Payment',
          callback_data: `approve_upi_${w.id}`
        }]);
      }

      if (isGift) {
        keyboard.push([{
          text: '🎁 Send Gift Card Code',
          callback_data: `approve_gift_${w.id}`
        }]);
      }

      if (!isUPI && !isGift) {
        keyboard.push([{
          text: '✅ Approve',
          callback_data: `approve_upi_${w.id}`
        }]);
        keyboard.push([{
          text: '🎁 Send Gift Code',
          callback_data: `approve_gift_${w.id}`
        }]);
      }

      keyboard.push([{
        text: '❌ Reject & Refund Tokens',
        callback_data: `reject_${w.id}`
      }]);

      await sendTelegram(chatId, msg, keyboard);
    }
  } catch(e) {
    console.error('Pending error:', e);
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

async function showStats(chatId) {
  try {
    const usersSnap = await db.ref('users').once('value');
    const withdrawalsSnap = await db.ref('withdrawals').once('value');

    let pending = 0, completed = 0, rejected = 0, totalPaid = 0;

    if (withdrawalsSnap.exists()) {
      withdrawalsSnap.forEach(child => {
        const w = child.val();
        if (w.status === 'Pending') pending++;
        if (w.status === 'Complete') { completed++; totalPaid += (w.amount || 0); }
        if (w.status === 'Rejected') rejected++;
      });
    }

    const totalUsers = usersSnap.exists()
      ? Object.keys(usersSnap.val()).length : 0;

    await sendTelegram(chatId,
      `📊 <b>VCEarn Stats</b>\n\n` +
      `👥 Total Users: ${totalUsers}\n` +
      `⏳ Pending: ${pending}\n` +
      `✅ Completed: ${completed}\n` +
      `❌ Rejected: ${rejected}\n` +
      `💰 Total Paid: ₹${totalPaid}`
    );
  } catch(e) {
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

async function showUsers(chatId) {
  try {
    const snap = await db.ref('users').once('value');
    const count = snap.exists()
      ? Object.keys(snap.val()).length : 0;
    await sendTelegram(chatId,
      `👥 <b>Total Users: ${count}</b>`
    );
  } catch(e) {
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id.toString();
  const data = cb.data;
  const msgId = cb.message.message_id;

  if (chatId !== ADMIN_CHAT_ID) return;

  // Approve UPI - ask for TXN ID
  if (data.startsWith('approve_upi_')) {
    const wId = data.replace('approve_upi_', '');

    // Verify withdrawal exists
    const snap = await db.ref(`withdrawals/${wId}`).once('value');
    if (!snap.exists()) {
      await sendTelegram(chatId, '❌ Withdrawal not found!');
      return;
    }
    const w = snap.val();

    // Set waiting state
    waitingForInput[chatId] = {
      type: 'txn',
      withdrawalId: wId
    };

    await sendTelegram(chatId,
      `💳 <b>Enter TXN ID</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `💳 UPI: ${w.upiId}\n\n` +
      `Type the Transaction ID now:\n` +
      `Example: <code>TXN123456789</code>`
    );
  }

  // Approve Gift - ask for code
  else if (data.startsWith('approve_gift_')) {
    const wId = data.replace('approve_gift_', '');

    const snap = await db.ref(`withdrawals/${wId}`).once('value');
    if (!snap.exists()) {
      await sendTelegram(chatId, '❌ Withdrawal not found!');
      return;
    }
    const w = snap.val();

    waitingForInput[chatId] = {
      type: 'code',
      withdrawalId: wId
    };

    await sendTelegram(chatId,
      `🎁 <b>Enter Gift Card Code</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `📋 Method: ${w.method}\n\n` +
      `Type the gift card code now:\n` +
      `Example: <code>AMZN-1234-5678-9012</code>`
    );
  }

  // Reject
  else if (data.startsWith('reject_')) {
    const wId = data.replace('reject_', '');
    await rejectWithdrawal(chatId, wId);
  }
}

async function approveUPI(chatId, withdrawalId, txnId) {
  try {
    await sendTelegram(chatId, '⏳ Processing approval...');

    const snap = await db.ref(`withdrawals/${withdrawalId}`).once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, `❌ Withdrawal not found!\nID: ${withdrawalId}`);
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}!`);
      return;
    }

    await db.ref(`withdrawals/${withdrawalId}`).update({
      status: 'Complete',
      txnId: txnId,
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`).transaction(user => {
      if (user) {
        user.totalWithdrawn = (user.totalWithdrawn || 0) + (w.amount || 0);
      }
      return user;
    });

    await sendTelegram(chatId,
      `✅ <b>Payment Approved!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `💳 UPI: ${w.upiId}\n` +
      `🔖 TXN ID: ${txnId}\n\n` +
      `User will see this in history ✅`
    );
  } catch(e) {
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

async function sendGiftCode(chatId, withdrawalId, code) {
  try {
    await sendTelegram(chatId, '⏳ Sending gift code...');

    const snap = await db.ref(`withdrawals/${withdrawalId}`).once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, `❌ Withdrawal not found!\nID: ${withdrawalId}`);
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}!`);
      return;
    }

    await db.ref(`withdrawals/${withdrawalId}`).update({
      status: 'Complete',
      giftCode: code,
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`).transaction(user => {
      if (user) {
        user.totalWithdrawn = (user.totalWithdrawn || 0) + (w.amount || 0);
      }
      return user;
    });

    await sendTelegram(chatId,
      `✅ <b>Gift Code Sent!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `📋 Method: ${w.method}\n` +
      `🎁 Code: <code>${code}</code>\n\n` +
      `User will see code in history ✅`
    );
  } catch(e) {
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

async function rejectWithdrawal(chatId, withdrawalId) {
  try {
    await sendTelegram(chatId, '⏳ Processing rejection...');

    const snap = await db.ref(`withdrawals/${withdrawalId}`).once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, `❌ Not found!\nID: ${withdrawalId}`);
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}!`);
      return;
    }

    const refund = w.amount === 20 ? 200 : w.amount === 50 ? 500 : 1000;

    await db.ref(`withdrawals/${withdrawalId}`).update({
      status: 'Rejected',
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`).transaction(user => {
      if (user) {
        user.tokens = (user.tokens || 0) + refund;
      }
      return user;
    });

    await sendTelegram(chatId,
      `❌ <b>Withdrawal Rejected!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount} rejected\n` +
      `🪙 ${refund} tokens refunded\n\n` +
      `Tokens restored to user ✅`
    );
  } catch(e) {
    await sendTelegram(chatId, `❌ Error: ${e.message}`);
  }
}

app.post('/notify-withdrawal', async (req, res) => {
  try {
    const { userName, amount, method, upiId, withdrawalId } = req.body;

    const isUPI = method === 'UPI';
    const isGift = method === 'Amazon' || method === 'Playstore';

    const msg =
      `🔔 <b>NEW WITHDRAWAL REQUEST!</b>\n\n` +
      `👤 ${userName || 'User'}\n` +
      `💰 ₹${amount}\n` +
      `📋 ${method}\n` +
      `💳 ${isUPI ? upiId : 'Gift Card'}\n` +
      `🆔 <code>${withdrawalId}</code>`;

    const keyboard = [];

    if (isUPI) {
      keyboard.push([{
        text: '✅ Approve UPI Payment',
        callback_data: `approve_upi_${withdrawalId}`
      }]);
    }

    if (isGift) {
      keyboard.push([{
        text: '🎁 Send Gift Card Code',
        callback_data: `approve_gift_${withdrawalId}`
      }]);
    }

    keyboard.push([{
      text: '❌ Reject & Refund',
      callback_data: `reject_${withdrawalId}`
    }]);

    await sendTelegram(ADMIN_CHAT_ID, msg, keyboard);
    res.json({ ok: true });
  } catch(e) {
    console.error('Notify error:', e);
    res.json({ ok: false });
  }
});

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
