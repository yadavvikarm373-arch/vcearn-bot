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
    credential: admin.credential.cert(
      serviceAccount
    ),
    databaseURL: DB_URL
  });
}

const db = admin.database();

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
      '/users - Total users\n\n' +
      '<b>Approve UPI payment:</b>\n' +
      '/txn_WITHDRAWALID_TXNID123\n\n' +
      '<b>Send Gift Card code:</b>\n' +
      '/code_WITHDRAWALID_GIFTCODE\n\n' +
      '<b>Note:</b> Use exact ID from withdrawal'
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
    // Use lastIndexOf to handle IDs with underscores
    const lastIdx = content.lastIndexOf('_');
    if (lastIdx === -1) {
      await sendTelegram(chatId,
        '❌ Format wrong!\n' +
        'Use: /txn_WITHDRAWALID_TXNID123'
      );
      return;
    }
    const wId = content.substring(0, lastIdx);
    const txnId = content.substring(lastIdx + 1);
    if (!wId || !txnId) {
      await sendTelegram(chatId,
        '❌ ID or TXN missing!\n' +
        'Use: /txn_WITHDRAWALID_TXNID123'
      );
      return;
    }
    await approveUPI(chatId, wId, txnId);
  }
  else if (text.startsWith('/code_')) {
    const content = text.replace('/code_', '');
    // Use lastIndexOf to handle IDs with underscores
    const lastIdx = content.lastIndexOf('_');
    if (lastIdx === -1) {
      await sendTelegram(chatId,
        '❌ Format wrong!\n' +
        'Use: /code_WITHDRAWALID_GIFTCODE'
      );
      return;
    }
    const wId = content.substring(0, lastIdx);
    const code = content.substring(lastIdx + 1);
    if (!wId || !code) {
      await sendTelegram(chatId,
        '❌ ID or Code missing!\n' +
        'Use: /code_WITHDRAWALID_GIFTCODE'
      );
      return;
    }
    await sendGiftCode(chatId, wId, code);
  }
  else {
    await sendTelegram(chatId,
      '❓ Unknown command\n' +
      'Use /start for help'
    );
  }
}

async function showPending(chatId) {
  try {
    await sendTelegram(chatId,
      '⏳ Fetching pending withdrawals...'
    );

    const snap = await db
      .ref('withdrawals')
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId,
        '✅ No withdrawals yet!'
      );
      return;
    }

    const pending = [];
    snap.forEach(child => {
      const w = child.val();
      if (w.status === 'Pending') {
        pending.push({
          id: child.key,
          ...w
        });
      }
    });

    if (pending.length === 0) {
      await sendTelegram(chatId,
        '✅ No pending withdrawals!'
      );
      return;
    }

    await sendTelegram(chatId,
      `📋 Found <b>${pending.length}</b> pending`
    );

    for (const w of pending) {
      const msg =
        `🔔 <b>Withdrawal Request</b>\n\n` +
        `👤 Name: ${w.userName || 'N/A'}\n` +
        `💰 Amount: ₹${w.amount}\n` +
        `📋 Method: ${w.method}\n` +
        `💳 UPI: ${w.upiId || 'Gift Card'}\n` +
        `🆔 ID: <code>${w.id}</code>\n\n` +
        `<b>✅ Approve UPI payment:</b>\n` +
        `/txn_${w.id}_TXNID123\n\n` +
        `<b>🎁 Send Gift Card code:</b>\n` +
        `/code_${w.id}_GIFTCODE`;

      const keyboard = [[{
        text: '❌ Reject & Refund Tokens',
        callback_data: `reject_${w.id}`
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

async function showStats(chatId) {
  try {
    await sendTelegram(chatId,
      '⏳ Fetching stats...'
    );

    const usersSnap = await db
      .ref('users')
      .once('value');

    const withdrawalsSnap = await db
      .ref('withdrawals')
      .once('value');

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
        if (w.status === 'Rejected') rejected++;
      });
    }

    const totalUsers = usersSnap.exists()
      ? Object.keys(usersSnap.val()).length
      : 0;

    await sendTelegram(chatId,
      `📊 <b>VCEarn Stats</b>\n\n` +
      `👥 Total Users: ${totalUsers}\n` +
      `⏳ Pending: ${pending}\n` +
      `✅ Completed: ${completed}\n` +
      `❌ Rejected: ${rejected}\n` +
      `💰 Total Paid: ₹${totalPaid}`
    );
  } catch(e) {
    console.error('Stats error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function showUsers(chatId) {
  try {
    await sendTelegram(chatId,
      '⏳ Fetching users...'
    );

    const snap = await db
      .ref('users')
      .once('value');

    const count = snap.exists()
      ? Object.keys(snap.val()).length
      : 0;

    await sendTelegram(chatId,
      `👥 <b>Total Users: ${count}</b>\n\n` +
      `Active VCEarn accounts`
    );
  } catch(e) {
    console.error('Users error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id.toString();
  const data = cb.data;

  if (chatId !== ADMIN_CHAT_ID) return;

  if (data.startsWith('reject_')) {
    const wId = data.replace('reject_', '');
    await rejectWithdrawal(chatId, wId);
  }
}

async function approveUPI(
  chatId, withdrawalId, txnId
) {
  try {
    await sendTelegram(chatId,
      `⏳ Processing approval...\nID: ${withdrawalId}`
    );

    const snap = await db
      .ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId,
        `❌ Withdrawal not found!\n` +
        `ID: ${withdrawalId}\n\n` +
        `Use /pending to see valid IDs`
      );
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId,
        `⚠️ Already ${w.status}!\n` +
        `Cannot approve again.`
      );
      return;
    }

    await db
      .ref(`withdrawals/${withdrawalId}`)
      .update({
        status: 'Complete',
        txnId: txnId,
        completeTime: Date.now()
      });

    await db
      .ref(`users/${w.userId}`)
      .transaction(user => {
        if (user) {
          user.totalWithdrawn =
            (user.totalWithdrawn || 0) +
            (w.amount || 0);
        }
        return user;
      });

    await sendTelegram(chatId,
      `✅ <b>Payment Approved!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `💳 UPI: ${w.upiId || 'N/A'}\n` +
      `🔖 TXN ID: ${txnId}\n\n` +
      `User will see this in their history.`
    );
  } catch(e) {
    console.error('Approve error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function sendGiftCode(
  chatId, withdrawalId, code
) {
  try {
    await sendTelegram(chatId,
      `⏳ Sending gift code...\nID: ${withdrawalId}`
    );

    const snap = await db
      .ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId,
        `❌ Withdrawal not found!\n` +
        `ID: ${withdrawalId}\n\n` +
        `Use /pending to see valid IDs`
      );
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId,
        `⚠️ Already ${w.status}!\n` +
        `Cannot process again.`
      );
      return;
    }

    await db
      .ref(`withdrawals/${withdrawalId}`)
      .update({
        status: 'Complete',
        giftCode: code,
        completeTime: Date.now()
      });

    await db
      .ref(`users/${w.userId}`)
      .transaction(user => {
        if (user) {
          user.totalWithdrawn =
            (user.totalWithdrawn || 0) +
            (w.amount || 0);
        }
        return user;
      });

    await sendTelegram(chatId,
      `✅ <b>Gift Code Sent!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount}\n` +
      `📋 Method: ${w.method}\n` +
      `🎁 Code: <code>${code}</code>\n\n` +
      `User will see code in their history.`
    );
  } catch(e) {
    console.error('Gift error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

async function rejectWithdrawal(
  chatId, withdrawalId
) {
  try {
    await sendTelegram(chatId,
      `⏳ Processing rejection...\nID: ${withdrawalId}`
    );

    const snap = await db
      .ref(`withdrawals/${withdrawalId}`)
      .once('value');

    if (!snap.exists()) {
      await sendTelegram(chatId,
        `❌ Not found!\nID: ${withdrawalId}`
      );
      return;
    }

    const w = snap.val();

    if (w.status !== 'Pending') {
      await sendTelegram(chatId,
        `⚠️ Already ${w.status}!`
      );
      return;
    }

    const refund =
      w.amount === 20 ? 200 :
      w.amount === 50 ? 500 :
      w.amount === 100 ? 1000 : 200;

    await db
      .ref(`withdrawals/${withdrawalId}`)
      .update({
        status: 'Rejected',
        completeTime: Date.now()
      });

    await db
      .ref(`users/${w.userId}`)
      .transaction(user => {
        if (user) {
          user.tokens =
            (user.tokens || 0) + refund;
        }
        return user;
      });

    await sendTelegram(chatId,
      `❌ <b>Withdrawal Rejected!</b>\n\n` +
      `👤 ${w.userName || 'User'}\n` +
      `💰 ₹${w.amount} rejected\n` +
      `🪙 ${refund} tokens refunded\n\n` +
      `Tokens restored to user account.`
    );
  } catch(e) {
    console.error('Reject error:', e);
    await sendTelegram(chatId,
      `❌ Error: ${e.message}`
    );
  }
}

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
        `<b>✅ Approve UPI:</b>\n` +
        `/txn_${withdrawalId}_TXNID\n\n` +
        `<b>🎁 Gift Code:</b>\n` +
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
      res.json({ ok: false });
    }
  }
);

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
