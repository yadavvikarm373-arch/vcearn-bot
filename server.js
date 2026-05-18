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

  serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, '\n');

} catch (e) {
  console.error('Firebase JSON Error:', e);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DB_URL
  });
}

const db = admin.database();

const waitingForInput = {};

function escapeHtml(text = '') {
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

  } catch (e) {
    console.error('Telegram Send Error:', e.message);
  }
}

async function removeButtons(chatId, messageId) {
  try {
    await axios.post(`${BOT_URL}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: []
      }
    });
  } catch (e) {}
}

app.post('/webhook', async (req, res) => {
  res.json({ ok: true });

  const update = req.body;

  try {

    if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    else if (update.message?.text) {
      await handleMessage(update.message);
    }

  } catch (e) {
    console.error('Webhook Error:', e);
  }
});

async function handleMessage(msg) {

  const chatId = msg.chat.id.toString();
  const text = msg.text.trim();

  if (chatId !== ADMIN_CHAT_ID) {
    await sendTelegram(chatId, '❌ Unauthorized');
    return;
  }

  // WAITING INPUT
  if (waitingForInput[chatId]) {

    const state = waitingForInput[chatId];

    delete waitingForInput[chatId];

    // TXN ID
    if (state.type === 'txn') {
      await approveUPI(
        chatId,
        state.withdrawalId,
        text
      );
      return;
    }

    // GIFT CODE
    if (state.type === 'gift_code') {
      await approveGift(
        chatId,
        state.withdrawalId,
        text
      );
      return;
    }

    // CUSTOM REJECTION
    if (state.type === 'custom_reject') {

      await rejectWithdrawal(
        chatId,
        state.withdrawalId,
        text
      );

      return;
    }
  }

  // COMMANDS

  if (text === '/start') {

    await sendTelegram(
      chatId,
      `👑 <b>VCEarn Admin Bot</b>

Commands:
/pending - Pending withdrawals
/stats - App statistics
/users - Total users`
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
    await sendTelegram(
      chatId,
      '❓ Unknown command'
    );
  }
}

async function showPending(chatId) {

  try {

    await sendTelegram(
      chatId,
      '⏳ Fetching pending withdrawals...'
    );

    const snap = await db.ref('withdrawals').once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, '✅ No withdrawals');
      return;
    }

    const pending = [];

    snap.forEach(child => {

      const w = child.val();

      if (w.status === 'Pending') {

        pending.push({
          withdrawalId: child.key,
          ...w
        });
      }
    });

    if (pending.length === 0) {
      await sendTelegram(chatId, '✅ No pending withdrawals');
      return;
    }

    await sendTelegram(
      chatId,
      `📋 Found ${pending.length} pending withdrawals`
    );

    for (const w of pending) {

      const method = w.method || '';

      const msg =
`🔔 <b>Withdrawal Request</b>

👤 Name: ${escapeHtml(w.userName || 'User')}
💰 Amount: ₹${w.amount}
📋 Method: ${escapeHtml(method)}
💳 ${method === 'UPI' ? escapeHtml(w.upiId || 'N/A') : 'Gift Card'}

🆔 ID:
<code>${w.withdrawalId}</code>`;

      const keyboard = [];

      // UPI
      if (method === 'UPI') {

        keyboard.push([{
          text: '✅ Approve UPI',
          callback_data: `approve_upi_${w.withdrawalId}`
        }]);
      }

      // AMAZON
      else if (method === 'Amazon') {

        keyboard.push([{
          text: '🎁 Send Amazon Code',
          callback_data: `approve_gift_${w.withdrawalId}`
        }]);
      }

      // PLAYSTORE
      else if (method === 'Playstore') {

        keyboard.push([{
          text: '🎮 Send Playstore Code',
          callback_data: `approve_gift_${w.withdrawalId}`
        }]);
      }

      keyboard.push([{
        text: '❌ Reject & Refund',
        callback_data: `reject_${w.withdrawalId}`
      }]);

      await sendTelegram(
        chatId,
        msg,
        keyboard
      );
    }

  } catch (e) {

    console.error(e);

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function showStats(chatId) {

  try {

    const usersSnap =
      await db.ref('users').once('value');

    const withdrawalsSnap =
      await db.ref('withdrawals').once('value');

    let pending = 0;
    let completed = 0;
    let rejected = 0;
    let totalPaid = 0;

    if (withdrawalsSnap.exists()) {

      withdrawalsSnap.forEach(child => {

        const w = child.val();

        if (w.status === 'Pending') pending++;

        if (w.status === 'Complete') {
          completed++;
          totalPaid += (w.amount || 0);
        }

        if (w.status === 'Rejected') {
          rejected++;
        }
      });
    }

    const totalUsers =
      usersSnap.exists()
      ? Object.keys(usersSnap.val()).length
      : 0;

    await sendTelegram(
      chatId,
`📊 <b>VCEarn Stats</b>

👥 Users: ${totalUsers}
⏳ Pending: ${pending}
✅ Completed: ${completed}
❌ Rejected: ${rejected}
💰 Total Paid: ₹${totalPaid}`
    );

  } catch (e) {

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function showUsers(chatId) {

  try {

    const snap =
      await db.ref('users').once('value');

    const count =
      snap.exists()
      ? Object.keys(snap.val()).length
      : 0;

    await sendTelegram(
      chatId,
      `👥 Total Users: ${count}`
    );

  } catch (e) {

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function handleCallback(cb) {

  const chatId = cb.message.chat.id.toString();
  const data = cb.data;
  const msgId = cb.message.message_id;

  if (chatId !== ADMIN_CHAT_ID) return;

  // REMOVE BUTTONS
  await removeButtons(chatId, msgId);

  // APPROVE UPI
  if (data.startsWith('approve_upi_')) {

    const withdrawalId =
      data.replace('approve_upi_', '');

    waitingForInput[chatId] = {
      type: 'txn',
      withdrawalId
    };

    await sendTelegram(
      chatId,
`💳 <b>Please enter TXN ID</b>

Type TXN ID now:`
    );
  }

  // APPROVE GIFT
  else if (data.startsWith('approve_gift_')) {

    const withdrawalId =
      data.replace('approve_gift_', '');

    waitingForInput[chatId] = {
      type: 'gift_code',
      withdrawalId
    };

    await sendTelegram(
      chatId,
`🎁 <b>Please enter gift card code</b>

Type code now:`
    );
  }

  // REJECT MENU
  else if (data.startsWith('reject_')) {

    const withdrawalId =
      data.replace('reject_', '');

    const keyboard = [

      [{
        text: '1️⃣ Server issue try again',
        callback_data: `reason_${withdrawalId}_Server issue try again`
      }],

      [{
        text: '2️⃣ Illegal token earning',
        callback_data: `reason_${withdrawalId}_Illegal token earning detected`
      }],

      [{
        text: '3️⃣ Wrong/Unsupported UPI',
        callback_data: `reason_${withdrawalId}_Wrong or unsupported UPI ID`
      }],

      [{
        text: '4️⃣ Suspicious activity',
        callback_data: `reason_${withdrawalId}_Suspicious activity detected`
      }],

      [{
        text: '5️⃣ Other ✍️',
        callback_data: `reason_other_${withdrawalId}`
      }]
    ];

    await sendTelegram(
      chatId,
      '❌ Select rejection reason',
      keyboard
    );
  }

  // CUSTOM REASON
  else if (data.startsWith('reason_other_')) {

    const withdrawalId =
      data.replace('reason_other_', '');

    waitingForInput[chatId] = {
      type: 'custom_reject',
      withdrawalId
    };

    await sendTelegram(
      chatId,
`✍️ <b>Type custom rejection reason</b>

Example:
Daily limit exceeded`
    );
  }

  // FIXED REASON
  else if (data.startsWith('reason_')) {

    const parts = data.split('_');

    const withdrawalId = parts[1];

    const reason =
      data.replace(`reason_${withdrawalId}_`, '');

    await rejectWithdrawal(
      chatId,
      withdrawalId,
      reason
    );
  }
}

async function approveUPI(chatId, withdrawalId, txnId) {

  try {

    const snap =
      await db.ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, '❌ Withdrawal not found');
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}`);
      return;
    }

    await db.ref(`withdrawals/${withdrawalId}`)
    .update({
      status: 'Complete',
      txnId,
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`)
    .transaction(user => {

      if (user) {
        user.totalWithdrawn =
          (user.totalWithdrawn || 0)
          + (w.amount || 0);
      }

      return user;
    });

    await sendTelegram(
      chatId,
`✅ <b>UPI Payment Approved</b>

👤 ${escapeHtml(w.userName || 'User')}
💰 ₹${w.amount}

🔖 TXN ID:
<code>${txnId}</code>`
    );

  } catch (e) {

    console.error(e);

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function approveGift(chatId, withdrawalId, code) {

  try {

    const snap =
      await db.ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, '❌ Withdrawal not found');
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}`);
      return;
    }

    await db.ref(`withdrawals/${withdrawalId}`)
    .update({
      status: 'Complete',
      giftCode: code,
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`)
    .transaction(user => {

      if (user) {

        user.totalWithdrawn =
          (user.totalWithdrawn || 0)
          + (w.amount || 0);
      }

      return user;
    });

    await sendTelegram(
      chatId,
`✅ <b>Gift Code Sent</b>

👤 ${escapeHtml(w.userName || 'User')}
💰 ₹${w.amount}

🎁 Code:
<code>${escapeHtml(code)}</code>`
    );

  } catch (e) {

    console.error(e);

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function rejectWithdrawal(chatId, withdrawalId, reason) {

  try {

    const snap =
      await db.ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId, '❌ Withdrawal not found');
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId, `⚠️ Already ${w.status}`);
      return;
    }

    const refund =
      w.tokensUsed ||
      (w.amount === 20 ? 200 :
      w.amount === 50 ? 500 : 1000);

    await db.ref(`withdrawals/${withdrawalId}`)
    .update({
      status: 'Rejected',
      rejectionReason: reason,
      refundedTokens: refund,
      completeTime: Date.now()
    });

    await db.ref(`users/${w.userId}`)
    .transaction(user => {

      if (user) {

        user.tokens =
          (user.tokens || 0)
          + refund;
      }

      return user;
    });

    await sendTelegram(
      chatId,
`❌ <b>Withdrawal Rejected</b>

👤 ${escapeHtml(w.userName || 'User')}
💰 ₹${w.amount}

📌 Reason:
${escapeHtml(reason)}

🪙 Refunded:
${refund} tokens`
    );

  } catch (e) {

    console.error(e);

    await sendTelegram(
      chatId,
      `❌ Error: ${e.message}`
    );
  }
}

app.post('/notify-withdrawal', async (req, res) => {

  try {

    const {
      userName,
      amount,
      method,
      upiId,
      withdrawalId
    } = req.body;

    const keyboard = [];

    // UPI
    if (method === 'UPI') {

      keyboard.push([{
        text: '✅ Approve UPI',
        callback_data: `approve_upi_${withdrawalId}`
      }]);
    }

    // AMAZON
    else if (method === 'Amazon') {

      keyboard.push([{
        text: '🎁 Send Amazon Code',
        callback_data: `approve_gift_${withdrawalId}`
      }]);
    }

    // PLAYSTORE
    else if (method === 'Playstore') {

      keyboard.push([{
        text: '🎮 Send Playstore Code',
        callback_data: `approve_gift_${withdrawalId}`
      }]);
    }

    keyboard.push([{
      text: '❌ Reject & Refund',
      callback_data: `reject_${withdrawalId}`
    }]);

    const msg =
`🔔 <b>NEW WITHDRAWAL REQUEST</b>

👤 ${escapeHtml(userName || 'User')}
💰 ₹${amount}
📋 ${escapeHtml(method)}

💳 ${method === 'UPI'
? escapeHtml(upiId || '')
: 'Gift Card'}

🆔
<code>${withdrawalId}</code>`;

    await sendTelegram(
      ADMIN_CHAT_ID,
      msg,
      keyboard
    );

    res.json({ ok: true });

  } catch (e) {

    console.error(e);

    res.json({
      ok: false,
      error: e.message
    });
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
  console.log(`Server running on ${PORT}`);
});
