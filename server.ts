import express from "express";
import { createServer as createViteServer } from "vite";
import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

dotenv.config({ quiet: true } as any);

// Global Error Handling to prevent crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 Uncaught Exception:", err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Setup ---
let db: Database.Database;
try {
  db = new Database("bot_database.db");
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error("❌ Database connection failed:", err);
  process.exit(1);
}

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    balance INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT, 
    amount INTEGER,
    method TEXT,
    status TEXT DEFAULT 'pending', 
    details TEXT,
    file_id TEXT,
    tx_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_jual', 'false');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_beli', 'false');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_topup', 'false');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_wd', 'false');
  
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_OVO', '081234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_OVO', 'ADMIN OVO');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_DANA', '081234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_DANA', 'ADMIN DANA');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_GOPAY', '081234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_GOPAY', 'ADMIN GOPAY');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_BCA', '1234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_BCA', 'ADMIN BCA');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_BRI', '1234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_BRI', 'ADMIN BRI');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('acc_MANDIRI', '1234567890');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name_MANDIRI', 'ADMIN MANDIRI');

  -- Method Statuses
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_OVO', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_DANA', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_GOPAY', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_BCA', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_BRI', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_topup_MANDIRI', 'true');

  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_OVO', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_DANA', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_GOPAY', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_BCA', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_BRI', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('status_wd_MANDIRI', 'true');
`);

// Ensure tx_hash column exists
try {
  db.exec("ALTER TABLE transactions ADD COLUMN tx_hash TEXT");
} catch (e) {}

// --- Bot Setup ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const bnbAdminAddress = (process.env.BNB_TESTNET_ADDRESS || "0x0000000000000000000000000000000000000000").toLowerCase();
let bnbRate = 10000; 
let bnbBuyRate = 11000; 
let usdtRate = 15000; 
let usdtBuyRate = 16000; 

const bscTestnetProvider = new ethers.JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545/");
const usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS || "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const hotWalletKey = process.env.HOT_WALLET_PRIVATE_KEY;
let hotWallet: ethers.Wallet | null = null;
if (hotWalletKey) {
  try {
    hotWallet = new ethers.Wallet(hotWalletKey, bscTestnetProvider);
    console.log(`✅ Hot Wallet initialized: ${hotWallet.address}`);
  } catch (e) {
    console.error("❌ Failed to initialize hot wallet:", e);
  }
}

async function updateRates() {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,tether&vs_currencies=idr");
    const data = await response.json() as any;
    
    if (data.binancecoin?.idr) {
      bnbRate = data.binancecoin.idr;
      bnbBuyRate = Math.floor(bnbRate * 1.1);
    }
    
    if (data.tether?.idr) {
      usdtRate = data.tether.idr;
      usdtBuyRate = Math.floor(usdtRate * 1.05);
    }
    console.log(`📊 Rates Updated - BNB: ${bnbRate}, USDT: ${usdtRate}`);
  } catch (error) {
    console.error("❌ Error fetching prices:", error);
  }
}

updateRates();
setInterval(updateRates, 5 * 60 * 1000);

let bot: TelegramBot | null = null;

function initBot() {
  if (!token) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set. Bot features are disabled.");
    return;
  }

  console.log("🤖 Initializing Telegram Bot...");
  try {
    bot = new TelegramBot(token.trim(), { polling: true });
    
    bot.getMe().then((me) => {
      console.log(`✅ Bot connected as @${me.username}`);
    }).catch((err) => {
      console.error("❌ Bot getMe error:", err.message);
    });

    bot.on("polling_error", (error) => {
      // Silently handle polling errors to avoid log spam
    });

    setupBotLogic(bot);
  } catch (err) {
    console.error("❌ Bot Initialization Failed:", err);
  }
}

// --- Helper Functions ---
function getUser(userId: number, username?: string) {
  let user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
  if (!user) {
    db.prepare("INSERT INTO users (id, username, balance) VALUES (?, ?, ?)").run(userId, username || "Unknown", 0);
    user = { id: userId, username: username || "Unknown", balance: 0 };
  } else if (username && user.username !== username) {
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, userId);
    user.username = username;
  }
  return user;
}

function formatIDR(amount: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

// --- Bot Logic ---
function setupBotLogic(activeBot: TelegramBot) {
  // Maintenance Status
  const maintenance = {
    jual: db.prepare("SELECT value FROM settings WHERE key = 'maintenance_jual'").get()?.value === 'true',
    beli: db.prepare("SELECT value FROM settings WHERE key = 'maintenance_beli'").get()?.value === 'true',
    topup: db.prepare("SELECT value FROM settings WHERE key = 'maintenance_topup'").get()?.value === 'true',
    wd: db.prepare("SELECT value FROM settings WHERE key = 'maintenance_wd'").get()?.value === 'true',
  };

  function toggleMaintenance(key: string) {
    const current = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value === 'true';
    const next = !current;
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(next.toString(), key);
    (maintenance as any)[key.replace('maintenance_', '')] = next;
    return next;
  }
  
  const userStates = new Map<number, { action: string; method: string; amount?: number }>();
  
  // Main Menu Keyboard
  const mainMenu = {
    reply_markup: {
      keyboard: [
        [{ text: "🚀 BELI TOKEN" }, { text: "💎 JUAL TOKEN" }],
        [{ text: "💳 TOPUP SALDO" }, { text: "💸 TARIK SALDO (WD)" }],
        [{ text: "👤 PROFIL & SALDO" }, { text: "📊 RIWAYAT" }]
      ],
      resize_keyboard: true,
    },
  };

  const cancelMenu = {
    reply_markup: {
      keyboard: [[{ text: "❌ BATALKAN PROSES" }]],
      resize_keyboard: true,
    },
  };

  // Start Command
  // (Moved to main message handler for reliability)

  // Riwayat Command
  // (Moved to main message handler for reliability)

  async function sendHistory(chatId: number) {
    try {
      const transactions = db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(chatId) as any[];
      if (transactions.length === 0) {
        activeBot.sendMessage(chatId, "Belum ada riwayat transaksi.");
      } else {
        let history = "<b>5 Transaksi Terakhir:</b>\n\n";
        transactions.forEach((t) => {
          const statusEmoji = t.status === 'approved' ? '✅' : (t.status === 'rejected' ? '❌' : '⏳');
          history += `${statusEmoji} ${t.type.toUpperCase()} - ${formatIDR(t.amount)}\nMethod: ${t.method}\nStatus: ${t.status}\nTanggal: ${t.created_at}\n\n`;
        });
        activeBot.sendMessage(chatId, history, { parse_mode: "HTML" });
      }
    } catch (error) {
      console.error("History Error:", error);
      activeBot.sendMessage(chatId, "❌ Gagal mengambil riwayat transaksi.");
    }
  }

  // Admin Command: List Users & Maintenance
  // (Moved to main message handler for reliability)

  // Handle Callback Queries
  activeBot.on("callback_query", (query) => {
    const chatId = query.message?.chat.id;
    const data = query.data;

    if (!chatId || !data) return;

    if (data.startsWith("topup_")) {
      const method = data.replace("topup_", "").toUpperCase();
      userStates.set(chatId, { action: "awaiting_topup_amount", method });
      activeBot.sendMessage(chatId, `Anda memilih Topup via ${method}.\n\nSilakan masukkan jumlah nominal (angka saja, misal: 50000):`, cancelMenu);
    }

    else if (data.startsWith("wd_")) {
      const method = data.replace("wd_", "").toUpperCase();
      userStates.set(chatId, { action: "awaiting_wd_amount", method });
      activeBot.sendMessage(chatId, `Anda memilih Penarikan via ${method}.\n\nSilakan masukkan jumlah nominal (angka saja, misal: 50000):`, cancelMenu);
    }

    else if (data === "menu_topup") {
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "OVO", callback_data: "topup_ovo" }, { text: "DANA", callback_data: "topup_dana" }],
            [{ text: "GoPay", callback_data: "topup_gopay" }],
            [{ text: "BCA", callback_data: "topup_bca" }, { text: "BRI", callback_data: "topup_bri" }],
            [{ text: "Mandiri", callback_data: "topup_mandiri" }]
          ]
        }
      };
      activeBot.sendMessage(chatId, "Pilih metode Topup:", opts);
    }

    else if (data === "menu_wd") {
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "OVO", callback_data: "wd_ovo" }, { text: "DANA", callback_data: "wd_dana" }],
            [{ text: "GoPay", callback_data: "wd_gopay" }],
            [{ text: "BCA", callback_data: "wd_bca" }, { text: "BRI", callback_data: "wd_bri" }],
            [{ text: "Mandiri", callback_data: "wd_mandiri" }]
          ]
        }
      };
      activeBot.sendMessage(chatId, "Pilih metode Penarikan (WD):", opts);
    }

    else if (data === "menu_history") {
      const transactions = db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5").all(chatId) as any[];
      if (transactions.length === 0) {
        activeBot.sendMessage(chatId, "Belum ada riwayat transaksi.");
      } else {
        let history = "*5 Transaksi Terakhir:*\n\n";
        transactions.forEach((t) => {
          const statusEmoji = t.status === 'approved' ? '✅' : (t.status === 'rejected' ? '❌' : '⏳');
          history += `${statusEmoji} ${t.type.toUpperCase()} - ${formatIDR(t.amount)}\nMethod: ${t.method}\nStatus: ${t.status}\nTanggal: ${t.created_at}\n\n`;
        });
        activeBot.sendMessage(chatId, history, { parse_mode: "Markdown" });
      }
    }

    else if (data === "select_jual_bnb") {
      updateRates().then(() => {
        userStates.set(chatId, { action: "awaiting_bnb_amount", method: "BNB_TESTNET", tokenType: "BNB" } as any);
        activeBot.sendMessage(chatId, `Anda memilih Jual BNB Testnet.\nRate Real-time: 1 BNB = *${formatIDR(bnbRate)}*\n\nSilakan masukkan jumlah BNB yang ingin dijual (misal: 0.5):`, { parse_mode: "Markdown" });
      });
    }

    else if (data === "select_jual_usdt") {
      updateRates().then(() => {
        userStates.set(chatId, { action: "awaiting_bnb_amount", method: "USDT_BEP20", tokenType: "USDT" } as any);
        activeBot.sendMessage(chatId, `Anda memilih Jual USDT BEP20.\nRate Real-time: 1 USDT = *${formatIDR(usdtRate)}*\n\nSilakan masukkan jumlah USDT yang ingin dijual (misal: 10):`, { parse_mode: "Markdown" });
      });
    }

    else if (data === "select_beli_bnb") {
      if (!hotWallet) {
        activeBot.sendMessage(chatId, "❌ Fitur Beli BNB sedang dinonaktifkan oleh admin (Hot Wallet belum siap).");
        return;
      }
      updateRates().then(() => {
        userStates.set(chatId, { action: "awaiting_buy_bnb_amount", method: "BNB_TESTNET", tokenType: "BNB" } as any);
        activeBot.sendMessage(chatId, `Anda memilih Beli BNB Testnet.\nRate: 1 BNB = *${formatIDR(bnbBuyRate)}*\n\nSilakan masukkan jumlah BNB yang ingin dibeli (misal: 0.1):`, { parse_mode: "Markdown" });
      });
    }

    else if (data === "select_beli_usdt") {
      if (!hotWallet) {
        activeBot.sendMessage(chatId, "❌ Fitur Beli USDT sedang dinonaktifkan oleh admin (Hot Wallet belum siap).");
        return;
      }
      updateRates().then(() => {
        userStates.set(chatId, { action: "awaiting_buy_bnb_amount", method: "USDT_BEP20", tokenType: "USDT" } as any);
        activeBot.sendMessage(chatId, `Anda memilih Beli USDT BEP20.\nRate: 1 USDT = *${formatIDR(usdtBuyRate)}*\n\nSilakan masukkan jumlah USDT yang ingin dibeli (misal: 10):`, { parse_mode: "Markdown" });
      });
    }

    // Admin maintenance toggles
    else if (data.startsWith("toggle_m_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const key = data.replace("toggle_m_", "maintenance_");
      toggleMaintenance(key);
      activeBot.answerCallbackQuery(query.id, { text: "Status Maintenance Diperbarui!" });
      
      // Update the message
      const users = db.prepare("SELECT * FROM users ORDER BY balance DESC").all() as any[];
      const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users").get() as any;
      let report = "📊 <b>LAPORAN ADMIN</b>\n\n";
      report += `Total User: ${users.length}\n`;
      report += `Total Saldo Beredar: ${formatIDR(totalBalance.total || 0)}\n\n`;
      report += "<b>Daftar User (Top 10):</b>\n";
      users.slice(0, 10).forEach((u, i) => {
        report += `${i+1}. @${u.username} - ${formatIDR(u.balance)}\n`;
      });

      const maintenanceMenu = {
        reply_markup: {
          inline_keyboard: [
            [{ text: `Jual: ${maintenance.jual ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_jual' },
             { text: `Beli: ${maintenance.beli ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_beli' }],
            [{ text: `Topup: ${maintenance.topup ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_topup' },
             { text: `WD: ${maintenance.wd ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_wd' }],
            [{ text: "🏦 Kelola Rekening Admin", callback_data: 'admin_manage_accounts' }],
            [{ text: "⚙️ Kelola Metode (ON/OFF)", callback_data: 'admin_manage_methods' }]
          ]
        }
      };
      activeBot.editMessageText(report + "\n<b>PENGATURAN MAINTENANCE:</b>\n(Klik untuk toggle status ON/OFF)", {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        ...maintenanceMenu
      });
    }

    else if (data === "admin_manage_methods") {
      if (String(chatId) !== String(adminChatId)) return;
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Metode Topup", callback_data: "admin_methods_topup" }],
            [{ text: "💸 Metode WD", callback_data: "admin_methods_wd" }],
            [{ text: "⬅️ Kembali", callback_data: "admin_back_to_main" }]
          ]
        }
      };
      activeBot.editMessageText("<b>KELOLA METODE PEMBAYARAN</b>\n\nSilakan pilih kategori metode yang ingin dikelola:", {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        ...opts
      });
    }

    else if (data.startsWith("admin_methods_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const type = data.replace("admin_methods_", ""); // 'topup' or 'wd'
      const methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      
      const inline_keyboard = methods.map(m => {
        const status = db.prepare("SELECT value FROM settings WHERE key = ?").get(`status_${type}_${m}`)?.value === 'true';
        return [{ text: `${m}: ${status ? '🟢 ON' : '🔴 OFF'}`, callback_data: `toggle_method_${type}_${m}` }];
      });
      
      inline_keyboard.push([{ text: "⬅️ Kembali", callback_data: "admin_manage_methods" }]);
      
      const opts = { reply_markup: { inline_keyboard } };
      activeBot.editMessageText(`<b>KELOLA METODE ${type.toUpperCase()}</b>\n\nKlik untuk toggle status ON/OFF:`, {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        ...opts
      });
    }

    else if (data.startsWith("toggle_method_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const parts = data.split("_"); // toggle, method, type, name
      const type = parts[2];
      const name = parts[3];
      const key = `status_${type}_${name}`;
      
      const current = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
      const newVal = current === 'true' ? 'false' : 'true';
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(newVal, key);
      
      activeBot.answerCallbackQuery(query.id, { text: `Metode ${name} ${newVal === 'true' ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'}` });
      
      // Refresh the menu
      const methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      const inline_keyboard = methods.map(m => {
        const status = db.prepare("SELECT value FROM settings WHERE key = ?").get(`status_${type}_${m}`)?.value === 'true';
        return [{ text: `${m}: ${status ? '🟢 ON' : '🔴 OFF'}`, callback_data: `toggle_method_${type}_${m}` }];
      });
      inline_keyboard.push([{ text: "⬅️ Kembali", callback_data: "admin_manage_methods" }]);
      
      activeBot.editMessageText(`<b>KELOLA METODE ${type.toUpperCase()}</b>\n\nKlik untuk toggle status ON/OFF:`, {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard }
      });
    }

    else if (data === "admin_manage_accounts") {
      if (String(chatId) !== String(adminChatId)) return;
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "OVO", callback_data: "edit_acc_OVO" }, { text: "DANA", callback_data: "edit_acc_DANA" }],
            [{ text: "GoPay", callback_data: "edit_acc_GOPAY" }],
            [{ text: "BCA", callback_data: "edit_acc_BCA" }, { text: "BRI", callback_data: "edit_acc_BRI" }],
            [{ text: "Mandiri", callback_data: "edit_acc_MANDIRI" }],
            [{ text: "⬅️ Kembali", callback_data: "admin_back_to_main" }]
          ]
        }
      };
      activeBot.editMessageText("<b>KELOLA REKENING ADMIN</b>\n\nSilakan pilih rekening yang ingin diubah:", {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        ...opts
      });
    }

    else if (data.startsWith("edit_acc_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const method = data.replace("edit_acc_", "");
      const currentAcc = db.prepare("SELECT value FROM settings WHERE key = ?").get(`acc_${method}`)?.value;
      const currentName = db.prepare("SELECT value FROM settings WHERE key = ?").get(`name_${method}`)?.value || "Belum diatur";
      
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✏️ Ubah Nomor/ID", callback_data: `change_num_${method}` }],
            [{ text: "✏️ Ubah Nama Rekening", callback_data: `change_name_${method}` }],
            [{ text: "⬅️ Kembali", callback_data: "admin_manage_accounts" }]
          ]
        }
      };

      activeBot.editMessageText(
        `<b>EDIT REKENING ${method}</b>\n\n` +
        `Nomor/ID: <code>${currentAcc}</code>\n` +
        `Nama: <b>${currentName}</b>\n\n` +
        `Apa yang ingin Anda ubah?`,
        {
          chat_id: chatId,
          message_id: query.message?.message_id,
          parse_mode: "HTML",
          ...opts
        }
      );
      activeBot.answerCallbackQuery(query.id);
    }

    else if (data.startsWith("change_num_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const method = data.replace("change_num_", "");
      const currentAcc = db.prepare("SELECT value FROM settings WHERE key = ?").get(`acc_${method}`)?.value;
      
      userStates.set(chatId, { action: "admin_editing_account", method });
      activeBot.sendMessage(chatId, `<b>EDIT NOMOR ${method}</b>\n\nNomor saat ini: <code>${currentAcc}</code>\n\nSilakan masukkan nomor rekening/e-wallet baru:`, { parse_mode: "HTML", ...cancelMenu });
      activeBot.answerCallbackQuery(query.id);
    }

    else if (data.startsWith("change_name_")) {
      if (String(chatId) !== String(adminChatId)) return;
      const method = data.replace("change_name_", "");
      const currentName = db.prepare("SELECT value FROM settings WHERE key = ?").get(`name_${method}`)?.value || "Belum diatur";
      
      userStates.set(chatId, { action: "admin_editing_name", method });
      activeBot.sendMessage(chatId, `<b>EDIT NAMA REKENING ${method}</b>\n\nNama saat ini: <b>${currentName}</b>\n\nSilakan masukkan nama pemilik rekening baru:`, { parse_mode: "HTML", ...cancelMenu });
      activeBot.answerCallbackQuery(query.id);
    }

    else if (data === "admin_back_to_main") {
      if (String(chatId) !== String(adminChatId)) return;
      
      const users = db.prepare("SELECT * FROM users ORDER BY balance DESC").all() as any[];
      const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users").get() as any;
      let report = "📊 <b>LAPORAN ADMIN</b>\n\n";
      report += `Total User: ${users.length}\n`;
      report += `Total Saldo Beredar: ${formatIDR(totalBalance.total || 0)}\n\n`;
      report += "<b>Daftar User (Top 10):</b>\n";
      users.slice(0, 10).forEach((u, i) => {
        report += `${i+1}. @${u.username} - ${formatIDR(u.balance)}\n`;
      });

      const maintenanceMenu = {
        reply_markup: {
          inline_keyboard: [
            [{ text: `Jual: ${maintenance.jual ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_jual' },
             { text: `Beli: ${maintenance.beli ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_beli' }],
            [{ text: `Topup: ${maintenance.topup ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_topup' },
             { text: `WD: ${maintenance.wd ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_wd' }],
            [{ text: "🏦 Kelola Rekening Admin", callback_data: 'admin_manage_accounts' }],
            [{ text: "⚙️ Kelola Metode (ON/OFF)", callback_data: 'admin_manage_methods' }]
          ]
        }
      };
      activeBot.editMessageText(report + "\n<b>PENGATURAN MAINTENANCE:</b>\n(Klik untuk toggle status ON/OFF)", {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "HTML",
        ...maintenanceMenu
      });
    }

    // Admin approval
    else if (data.startsWith("approve_") || data.startsWith("reject_")) {
      if (String(chatId) !== String(adminChatId)) {
        activeBot.answerCallbackQuery(query.id, { text: "Hanya admin yang bisa melakukan ini!" });
        return;
      }

      const [action, txId] = data.split("_");
      const tx = db.prepare(`
        SELECT t.*, u.username 
        FROM transactions t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.id = ?
      `).get(txId) as any;

      if (!tx || tx.status !== "pending") {
        activeBot.answerCallbackQuery(query.id, { text: "Transaksi sudah diproses atau tidak ditemukan." });
        return;
      }

      let newStatus = action === "approve" ? "approved" : "rejected";
      db.prepare("UPDATE transactions SET status = ? WHERE id = ?").run(newStatus, txId);

      const statusEmoji = action === "approve" ? "✅" : "❌";
      const statusText = action === "approve" ? "DISETUJUI" : "DITOLAK";
      
      let adminMsg = "";
      if (tx.type === "topup") {
        adminMsg = `🔔 <b>TOPUP ${statusText}</b>\n\n` +
                   `ID Transaksi: #${txId}\n` +
                   `User: @${tx.username || tx.user_id}\n` +
                   `Nominal: <b>${formatIDR(tx.amount)}</b>\n` +
                   `Metode: <b>${tx.method}</b>\n` +
                   `Detail: <b>${tx.details}</b>\n\n` +
                   `${statusEmoji} Status: <b>${statusText} oleh Admin</b>`;
        
        if (action === "approve") {
          db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(tx.amount, tx.user_id);
          activeBot.sendMessage(tx.user_id, `✅ Topup sebesar *${formatIDR(tx.amount)}* telah DISETUJUI.\nSaldo Anda telah ditambahkan.`, { parse_mode: "Markdown" });
        } else {
          activeBot.sendMessage(tx.user_id, `❌ Transaksi sebesar *${formatIDR(tx.amount)}* DITOLAK oleh Admin.`, { parse_mode: "Markdown" });
        }
        activeBot.editMessageCaption(adminMsg, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: "HTML" });
      } else {
        adminMsg = `🔔 <b>WD ${statusText}</b>\n\n` +
                   `ID Transaksi: #${txId}\n` +
                   `User: @${tx.username || tx.user_id}\n` +
                   `Nominal: <b>${formatIDR(tx.amount)}</b>\n` +
                   `Metode: <b>${tx.method}</b>\n` +
                   `Detail:\n<code>${tx.details}</code>\n\n` +
                   `${statusEmoji} Status: <b>${statusText} oleh Admin</b>`;

        if (action === "approve") {
          activeBot.sendMessage(tx.user_id, `✅ Penarikan sebesar *${formatIDR(tx.amount)}* telah DISETUJUI dan diproses.`, { parse_mode: "Markdown" });
        } else {
          db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(tx.amount, tx.user_id);
          activeBot.sendMessage(tx.user_id, `❌ Transaksi sebesar *${formatIDR(tx.amount)}* DITOLAK oleh Admin.`, { parse_mode: "Markdown" });
        }
        activeBot.editMessageText(adminMsg, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: "HTML" });
      }
      activeBot.answerCallbackQuery(query.id);
    }
  });

  // Handle All Messages (Menu & State-based)
  activeBot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id;
      const rawText = msg.text || "";
      const text = rawText.trim();

      if (!text && !msg.photo) return; 
      
      console.log(`📩 [BOT] Message from ${chatId} (@${msg.from?.username}): "${text || "[Photo]"}"`);

      if (!text) return;

      // 1. Handle Commands
      if (text === "/ping") {
        console.log(`🏓 Ping from ${chatId}`);
        await activeBot.sendMessage(chatId, "🏓 <b>PONG!</b> Bot is active.", { parse_mode: "HTML" });
        return;
      }

    const isStart = text.startsWith("/start");
    const isRiwayat = text.startsWith("/riwayat");
    const isAdmin = text.startsWith("/admin");

    if (isStart) {
      console.log(`🚀 Handling /start for ${chatId}`);
      getUser(chatId, msg.from?.username);
      activeBot.sendMessage(
        chatId,
        "👋 <b>Selamat Datang di IDR Payment Bot!</b>\n\n" +
        "Kami menyediakan layanan pertukaran aset digital (Crypto) ke Rupiah secara aman dan instan.\n\n" +
        "🚀 <b>Fitur Utama:</b>\n" +
        "• Beli & Jual Token (BNB/USDT)\n" +
        "• Topup & Tarik Saldo (WD)\n" +
        "• Verifikasi Otomatis & Manual\n\n" +
        "Silakan pilih menu di bawah untuk memulai transaksi Anda.",
        { parse_mode: "HTML", ...mainMenu }
      ).catch(err => console.error(`❌ Error sending /start:`, err));
      return;
    }

    if (isRiwayat) {
      console.log(`📊 Handling /riwayat for ${chatId}`);
      sendHistory(chatId);
      return;
    }

    if (isAdmin) {
      console.log(`🔑 Handling /admin for ${chatId}`);
      if (String(chatId) !== String(adminChatId)) {
        console.warn(`🚫 Unauthorized /admin attempt from ${chatId}`);
        return;
      }

      const users = db.prepare("SELECT * FROM users ORDER BY balance DESC").all() as any[];
      const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users").get() as any;
      
      let report = "📊 <b>LAPORAN ADMIN</b>\n\n";
      report += `Total User: ${users.length}\n`;
      report += `Total Saldo Beredar: ${formatIDR(totalBalance.total || 0)}\n\n`;
      report += "<b>Daftar User (Top 10):</b>\n";
      
      users.slice(0, 10).forEach((u, i) => {
        report += `${i+1}. @${u.username} - ${formatIDR(u.balance)}\n`;
      });

      const maintenanceMenu = {
        reply_markup: {
          inline_keyboard: [
            [{ text: `Jual: ${maintenance.jual ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_jual' },
             { text: `Beli: ${maintenance.beli ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_beli' }],
            [{ text: `Topup: ${maintenance.topup ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_topup' },
             { text: `WD: ${maintenance.wd ? '🔴 OFF' : '🟢 ON'}`, callback_data: 'toggle_m_wd' }],
            [{ text: "🏦 Kelola Rekening Admin", callback_data: 'admin_manage_accounts' }],
            [{ text: "⚙️ Kelola Metode (ON/OFF)", callback_data: 'admin_manage_methods' }]
          ]
        }
      };

      activeBot.sendMessage(chatId, report + "\n<b>PENGATURAN MAINTENANCE:</b>\n(Klik untuk toggle status ON/OFF)", { parse_mode: "HTML", ...maintenanceMenu });
      return;
    }

    if (text.startsWith("/")) return;

    const user = getUser(chatId, msg.from?.username);

    // 2. Handle Main Menu Commands (Priority)
    if (text.includes("💎 JUAL TOKEN")) {
      if (maintenance.jual) {
        activeBot.sendMessage(chatId, "⚠️ <b>FITUR MAINTENANCE</b>\n\nLayanan Jual Token sedang dalam pemeliharaan rutin. Silakan hubungi admin atau coba lagi nanti.", { parse_mode: "HTML" });
        return;
      }
      userStates.set(chatId, { action: "selecting_token_jual", method: "" });
      const opts = {
        reply_markup: {
          keyboard: [
            [{ text: "🪙 BNB Testnet (Jual)" }, { text: "💵 USDT BEP20 (Jual)" }],
            [{ text: "❌ BATALKAN PROSES" }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      };
      activeBot.sendMessage(chatId, "✨ <b>MENU PENJUALAN TOKEN</b>\n\nSilakan pilih aset digital yang ingin Anda tukarkan ke Rupiah:", { parse_mode: "HTML", ...opts });
      return;
    }

    else if (text.includes("🚀 BELI TOKEN")) {
      if (maintenance.beli) {
        activeBot.sendMessage(chatId, "⚠️ <b>FITUR MAINTENANCE</b>\n\nLayanan Beli Token sedang dalam pemeliharaan rutin. Silakan hubungi admin atau coba lagi nanti.", { parse_mode: "HTML" });
        return;
      }
      userStates.set(chatId, { action: "selecting_token_beli", method: "" });
      const opts = {
        reply_markup: {
          keyboard: [
            [{ text: "🪙 BNB Testnet (Beli)" }, { text: "💵 USDT BEP20 (Beli)" }],
            [{ text: "❌ BATALKAN PROSES" }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      };
      activeBot.sendMessage(chatId, "✨ <b>MENU PEMBELIAN TOKEN</b>\n\nSilakan pilih aset digital yang ingin Anda beli menggunakan saldo Rupiah Anda:", { parse_mode: "HTML", ...opts });
      return;
    }

    else if (text.includes("❌ BATALKAN PROSES")) {
      userStates.delete(chatId);
      activeBot.sendMessage(chatId, "🔄 <b>Proses Dibatalkan.</b>\nKembali ke menu utama.", { parse_mode: "HTML", ...mainMenu });
      return;
    }

    else if (text.includes("👤 PROFIL & SALDO")) {
      activeBot.sendMessage(chatId, 
        `👤 <b>PROFIL PENGGUNA</b>\n\n` +
        `Username: @${msg.from?.username || "N/A"}\n` +
        `ID: <code>${chatId}</code>\n` +
        `Saldo Aktif: <b>${formatIDR(user.balance)}</b>`, 
        { parse_mode: "HTML" }
      );
      return;
    } 
    
    else if (text.includes("💳 TOPUP SALDO")) {
      if (maintenance.topup) {
        activeBot.sendMessage(chatId, "⚠️ <b>FITUR MAINTENANCE</b>\n\nLayanan Topup sedang dalam pemeliharaan rutin. Silakan coba lagi nanti.", { parse_mode: "HTML" });
        return;
      }
      userStates.set(chatId, { action: "selecting_topup_method", method: "" });
      
      const methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      const enabledMethods = methods.filter(m => db.prepare("SELECT value FROM settings WHERE key = ?").get(`status_topup_${m}`)?.value === 'true');
      
      if (enabledMethods.length === 0) {
        activeBot.sendMessage(chatId, "⚠️ Maaf, saat ini tidak ada metode topup yang tersedia. Silakan hubungi admin.", { parse_mode: "HTML" });
        return;
      }

      const keyboard: any[][] = [];
      for (let i = 0; i < enabledMethods.length; i += 2) {
        const row = [];
        const m1 = enabledMethods[i];
        const icon1 = ["OVO", "DANA", "GOPAY"].includes(m1) ? "📱" : "🏦";
        row.push({ text: `${icon1} ${m1} (Topup)` });
        
        if (i + 1 < enabledMethods.length) {
          const m2 = enabledMethods[i+1];
          const icon2 = ["OVO", "DANA", "GOPAY"].includes(m2) ? "📱" : "🏦";
          row.push({ text: `${icon2} ${m2} (Topup)` });
        }
        keyboard.push(row);
      }
      keyboard.push([{ text: "❌ BATALKAN PROSES" }]);

      const opts = {
        reply_markup: {
          keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      };
      activeBot.sendMessage(chatId, "💳 <b>METODE PEMBAYARAN TOPUP</b>\n\nSilakan pilih metode pembayaran yang ingin Anda gunakan:", { parse_mode: "HTML", ...opts });
      return;
    }

    else if (text.includes("💸 TARIK SALDO (WD)")) {
      if (maintenance.wd) {
        activeBot.sendMessage(chatId, "⚠️ <b>FITUR MAINTENANCE</b>\n\nLayanan Penarikan sedang dalam pemeliharaan rutin. Silakan coba lagi nanti.", { parse_mode: "HTML" });
        return;
      }
      userStates.set(chatId, { action: "selecting_wd_method", method: "" });
      
      const methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      const enabledMethods = methods.filter(m => db.prepare("SELECT value FROM settings WHERE key = ?").get(`status_wd_${m}`)?.value === 'true');
      
      if (enabledMethods.length === 0) {
        activeBot.sendMessage(chatId, "⚠️ Maaf, saat ini tidak ada metode penarikan yang tersedia. Silakan hubungi admin.", { parse_mode: "HTML" });
        return;
      }

      const keyboard: any[][] = [];
      for (let i = 0; i < enabledMethods.length; i += 2) {
        const row = [];
        const m1 = enabledMethods[i];
        const icon1 = ["OVO", "DANA", "GOPAY"].includes(m1) ? "📱" : "🏦";
        row.push({ text: `${icon1} ${m1} (WD)` });
        
        if (i + 1 < enabledMethods.length) {
          const m2 = enabledMethods[i+1];
          const icon2 = ["OVO", "DANA", "GOPAY"].includes(m2) ? "📱" : "🏦";
          row.push({ text: `${icon2} ${m2} (WD)` });
        }
        keyboard.push(row);
      }
      keyboard.push([{ text: "❌ BATALKAN PROSES" }]);

      const opts = {
        reply_markup: {
          keyboard,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      };
      activeBot.sendMessage(chatId, "💸 <b>METODE PENARIKAN SALDO</b>\n\nSilakan pilih tujuan penarikan saldo Anda:", { parse_mode: "HTML", ...opts });
      return;
    }

    else if (text.includes("📊 RIWAYAT")) {
      sendHistory(chatId);
      return;
    }

    // 2. Handle State-based Inputs
    const state = userStates.get(chatId);
    if (!state) return;

    // Handle Token Selection (Jual)
    if (state.action === "selecting_token_jual") {
      if (text.includes("BNB Testnet (Jual)")) {
        updateRates().then(() => {
          userStates.set(chatId, { action: "awaiting_bnb_amount", method: "BNB_TESTNET", tokenType: "BNB" } as any);
          activeBot.sendMessage(chatId, `🪙 <b>JUAL BNB TESTNET</b>\n\nRate Saat Ini: <code>1 BNB = ${formatIDR(bnbRate)}</code>\n\nSilakan masukkan jumlah BNB yang ingin dijual (misal: 0.5):`, { parse_mode: "HTML", ...cancelMenu });
        });
      } else if (text.includes("USDT BEP20 (Jual)")) {
        updateRates().then(() => {
          userStates.set(chatId, { action: "awaiting_bnb_amount", method: "USDT_BEP20", tokenType: "USDT" } as any);
          activeBot.sendMessage(chatId, `💵 <b>JUAL USDT BEP20</b>\n\nRate Saat Ini: <code>1 USDT = ${formatIDR(usdtRate)}</code>\n\nSilakan masukkan jumlah USDT yang ingin dijual (misal: 10):`, { parse_mode: "HTML", ...cancelMenu });
        });
      }
      return;
    }

    // Handle Token Selection (Beli)
    else if (state.action === "selecting_token_beli") {
      if (text.includes("BNB Testnet (Beli)")) {
        if (!hotWallet) {
          activeBot.sendMessage(chatId, "❌ <b>SISTEM OFFLINE</b>\n\nFitur Beli BNB sedang dinonaktifkan oleh admin (Hot Wallet belum siap).", { parse_mode: "HTML", ...mainMenu });
          userStates.delete(chatId);
          return;
        }
        updateRates().then(() => {
          userStates.set(chatId, { action: "awaiting_buy_bnb_amount", method: "BNB_TESTNET", tokenType: "BNB" } as any);
          activeBot.sendMessage(chatId, `🪙 <b>BELI BNB TESTNET</b>\n\nRate Saat Ini: <code>1 BNB = ${formatIDR(bnbBuyRate)}</code>\n\nSilakan masukkan jumlah BNB yang ingin dibeli (misal: 0.1):`, { parse_mode: "HTML", ...cancelMenu });
        });
      } else if (text.includes("USDT BEP20 (Beli)")) {
        if (!hotWallet) {
          activeBot.sendMessage(chatId, "❌ <b>SISTEM OFFLINE</b>\n\nFitur Beli USDT sedang dinonaktifkan oleh admin (Hot Wallet belum siap).", { parse_mode: "HTML", ...mainMenu });
          userStates.delete(chatId);
          return;
        }
        updateRates().then(() => {
          userStates.set(chatId, { action: "awaiting_buy_bnb_amount", method: "USDT_BEP20", tokenType: "USDT" } as any);
          activeBot.sendMessage(chatId, `💵 <b>BELI USDT BEP20</b>\n\nRate Saat Ini: <code>1 USDT = ${formatIDR(usdtBuyRate)}</code>\n\nSilakan masukkan jumlah USDT yang ingin dibeli (misal: 10):`, { parse_mode: "HTML", ...cancelMenu });
        });
      }
      return;
    }

    // Handle Topup Method Selection
    else if (state.action === "selecting_topup_method") {
      const method = text.replace(/📱 |🏦 | \(Topup\)/g, "").toUpperCase();
      const validMethods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      if (validMethods.includes(method)) {
        userStates.set(chatId, { action: "awaiting_topup_amount", method });
        activeBot.sendMessage(chatId, `✅ <b>METODE TERPILIH: ${method}</b>\n\nSilakan masukkan nominal Rupiah yang ingin Anda isi (angka saja, misal: 50000):`, { parse_mode: "HTML", ...cancelMenu });
      }
      return;
    }

    // Handle WD Method Selection
    else if (state.action === "selecting_wd_method") {
      const method = text.replace(/📱 |🏦 | \(WD\)/g, "").toUpperCase();
      const validMethods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"];
      if (validMethods.includes(method)) {
        userStates.set(chatId, { action: "awaiting_wd_amount", method });
        activeBot.sendMessage(chatId, `✅ <b>TUJUAN WD TERPILIH: ${method}</b>\n\nSilakan masukkan nominal Rupiah yang ingin Anda tarik (angka saja, misal: 50000):`, { parse_mode: "HTML", ...cancelMenu });
      }
      return;
    }

    // Handle Admin Editing Account
    else if (state.action === "admin_editing_account") {
      if (String(chatId) !== String(adminChatId)) return;
      const newAcc = text;
      if (!newAcc) return;

      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(newAcc, `acc_${state.method}`);
      activeBot.sendMessage(chatId, `✅ <b>BERHASIL!</b>\n\nNomor rekening untuk <b>${state.method}</b> telah diubah menjadi: <code>${newAcc}</code>`, { parse_mode: "HTML", ...mainMenu });
      userStates.delete(chatId);
      return;
    }

    // Handle Admin Editing Name
    else if (state.action === "admin_editing_name") {
      if (String(chatId) !== String(adminChatId)) return;
      const newName = text;
      if (!newName) return;

      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(newName, `name_${state.method}`);
      activeBot.sendMessage(chatId, `✅ <b>BERHASIL!</b>\n\nNama rekening untuk <b>${state.method}</b> telah diubah menjadi: <b>${newName}</b>`, { parse_mode: "HTML", ...mainMenu });
      userStates.delete(chatId);
      return;
    }

    // Handle Topup Amount
    else if (state.action === "awaiting_topup_amount") {
      const amount = parseInt(msg.text || "");
      if (isNaN(amount) || amount < 1000) {
        activeBot.sendMessage(chatId, "Nominal tidak valid. Minimal topup adalah Rp 1.000. Silakan masukkan angka saja:");
        return;
      }
      state.amount = amount;
      state.action = "awaiting_topup_sender_name";
      activeBot.sendMessage(chatId, "Silakan masukkan NAMA PENGIRIM (sesuai nama di rekening/e-wallet Anda):", cancelMenu);
    }

    // Handle Topup Sender Name
    else if (state.action === "awaiting_topup_sender_name") {
      const senderName = msg.text;
      if (!senderName) return;
      
      (state as any).senderName = senderName;
      state.action = "awaiting_topup_proof";
      const adminAcc = db.prepare("SELECT value FROM settings WHERE key = ?").get(`acc_${state.method}`)?.value || "081234567890";
      const adminName = db.prepare("SELECT value FROM settings WHERE key = ?").get(`name_${state.method}`)?.value || "ADMIN";
      activeBot.sendMessage(chatId, `Silakan transfer <b>${formatIDR(state.amount!)}</b> ke:\n\n<b>${state.method} Admin:</b> <code>${adminAcc}</code>\na/n <b>${adminName}</b>\n\nSetelah transfer, kirimkan FOTO BUKTI TRANSFER di sini.`, { parse_mode: "HTML", ...cancelMenu });
    }

    // Handle Token Amount (Jual)
    else if (state.action === "awaiting_bnb_amount") {
      const amount = parseFloat(msg.text || "");
      if (isNaN(amount) || amount <= 0) {
        activeBot.sendMessage(chatId, `Jumlah ${(state as any).tokenType} tidak valid. Silakan masukkan angka:`);
        return;
      }
      const rate = (state as any).tokenType === "BNB" ? bnbRate : usdtRate;
      const idrAmount = Math.floor(amount * rate);
      state.amount = idrAmount;
      (state as any).bnbAmount = amount;
      state.action = "awaiting_bnb_wallet";
      activeBot.sendMessage(chatId, `Silakan masukkan *Alamat Wallet Pengirim* (Alamat Anda yang digunakan untuk mengirim ${(state as any).tokenType}):`, { parse_mode: "Markdown", ...cancelMenu });
    }

    // Handle Token Wallet Address
    else if (state.action === "awaiting_bnb_wallet") {
      const wallet = msg.text?.trim();
      if (!wallet || !wallet.startsWith("0x") || wallet.length !== 42) {
        activeBot.sendMessage(chatId, "Alamat wallet tidak valid. Pastikan diawali dengan '0x' dan memiliki panjang yang benar:", cancelMenu);
        return;
      }
      (state as any).senderWallet = wallet.toLowerCase();
      state.action = "awaiting_bnb_txid";
      const tokenType = (state as any).tokenType;
      activeBot.sendMessage(chatId, 
        `🔸 *KONFIRMASI JUAL ${tokenType}*\n\n` +
        `Jumlah: *${(state as any).bnbAmount} ${tokenType}*\n` +
        `Nominal Jual: *${formatIDR(state.amount!)}*\n` +
        `Wallet Pengirim: \`${(state as any).senderWallet}\`\n\n` +
        `Silakan kirim ${tokenType} ke alamat berikut:\n` +
        `\`${bnbAdminAddress}\`\n\n` +
        `Setelah transfer, kirimkan *TXID / Hash Transaksi* di sini sebagai bukti.`, 
        { parse_mode: "Markdown", ...cancelMenu }
      );
    }

    // Handle BNB TXID
    else if (state.action === "awaiting_bnb_txid") {
      const txid = msg.text?.trim();
      if (!txid) return;

      // Check if TXID already used
      const existingTx = db.prepare("SELECT * FROM transactions WHERE tx_hash = ?").get(txid);
      if (existingTx) {
        activeBot.sendMessage(chatId, "❌ TXID ini sudah pernah digunakan sebelumnya.");
        return;
      }

      activeBot.sendMessage(chatId, "⏳ Sedang memverifikasi transaksi on-chain...");

      try {
        const tx = await bscTestnetProvider.getTransaction(txid);
        if (!tx) {
          activeBot.sendMessage(chatId, "❌ Transaksi tidak ditemukan. Pastikan TXID benar dan sudah terkonfirmasi di network.");
          return;
        }

        const receipt = await bscTestnetProvider.getTransactionReceipt(txid);
        if (!receipt || receipt.status !== 1) {
          activeBot.sendMessage(chatId, "❌ Transaksi gagal atau belum sukses di network.");
          return;
        }

        // Verify amount and recipient
        const tokenType = (state as any).tokenType;
        let tokenSent = 0;
        
        if (tokenType === "BNB") {
          // Verify recipient
          if (tx.to?.toLowerCase() !== bnbAdminAddress) {
            activeBot.sendMessage(chatId, `❌ Alamat tujuan tidak sesuai. Harusnya ke: \`${bnbAdminAddress}\``, { parse_mode: "Markdown" });
            return;
          }
          tokenSent = parseFloat(ethers.formatEther(tx.value));
        } else {
          // USDT BEP20 (ERC20)
          if (tx.to?.toLowerCase() !== usdtContractAddress.toLowerCase()) {
            activeBot.sendMessage(chatId, `❌ Transaksi ini bukan pengiriman USDT BEP20.`);
            return;
          }
          
          const iface = new ethers.Interface(ERC20_ABI);
          try {
            const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });
            if (!decoded || decoded.name !== "transfer") {
              activeBot.sendMessage(chatId, "❌ Transaksi bukan merupakan transfer token.");
              return;
            }
            
            const [to, amount] = decoded.args;
            if (to.toLowerCase() !== bnbAdminAddress) {
              activeBot.sendMessage(chatId, `❌ Alamat tujuan token tidak sesuai. Harusnya ke: \`${bnbAdminAddress}\``, { parse_mode: "Markdown" });
              return;
            }
            
            // Assuming 18 decimals for testnet USDT, adjust if needed
            tokenSent = parseFloat(ethers.formatUnits(amount, 18));
          } catch (e) {
            activeBot.sendMessage(chatId, "❌ Gagal membedah data transaksi token.");
            return;
          }
        }

        const expectedTokenAmount = (state as any).bnbAmount;
        if (tokenSent < expectedTokenAmount * 0.99) {
          activeBot.sendMessage(chatId, `❌ Jumlah ${tokenType} yang dikirim (${tokenSent}) kurang dari yang diminta (${expectedTokenAmount}).`);
          return;
        }

        // Auto Approve
        const rate = tokenType === "BNB" ? bnbRate : usdtRate;
        const idrAmount = Math.floor(tokenSent * rate);
        const txId = db.prepare("INSERT INTO transactions (user_id, type, amount, method, tx_hash, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          chatId, 'topup', idrAmount, state.method, txid, 'approved', `${tokenType}: ${tokenSent}\nAuto-Verified`
        ).lastInsertRowid;

        db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(idrAmount, chatId);

        activeBot.sendMessage(chatId, 
          `✅ <b>PENJUALAN ${tokenType} BERHASIL!</b>\n\n` +
          `<b>Detail Transaksi:</b>\n` +
          `• Wallet: <code>${tx.from}</code>\n` +
          `• Jumlah: <b>${tokenSent} ${tokenType}</b>\n` +
          `• Rate: <b>${formatIDR(rate)}</b>\n` +
          `• Hasil: <b>${formatIDR(idrAmount)}</b>\n\n` +
          `Saldo telah ditambahkan ke akun Anda secara otomatis.`, 
          { parse_mode: "HTML", ...mainMenu }
        );

        if (adminChatId) {
          activeBot.sendMessage(adminChatId, 
            `🤖 <b>AUTO-VERIFIED ${tokenType} SALE</b>\n\n` +
            `ID Transaksi: #${txId}\n` +
            `User: @${msg.from?.username || chatId}\n` +
            `Wallet: <code>${tx.from}</code>\n` +
            `Aset: <b>${tokenSent} ${tokenType}</b>\n` +
            `Total IDR: <b>${formatIDR(idrAmount)}</b>\n` +
            `TXID: <code>${txid}</code>`,
            { parse_mode: "HTML" }
          );
        }
        userStates.delete(chatId);

      } catch (error) {
        console.error("Verification Error:", error);
        activeBot.sendMessage(chatId, "❌ Terjadi kesalahan saat memverifikasi transaksi. Silakan coba lagi nanti atau hubungi admin.");
      }
    }

    // Handle Withdrawal Amount
    else if (state.action === "awaiting_wd_amount") {
      const amount = parseInt(msg.text || "");
      const user = getUser(chatId);
      if (isNaN(amount) || amount < 10000) {
        activeBot.sendMessage(chatId, "Nominal tidak valid. Minimal penarikan adalah Rp 10.000. Silakan masukkan angka saja:");
        return;
      }
      if (amount > user.balance) {
        activeBot.sendMessage(chatId, `Saldo tidak cukup. Saldo Anda: ${formatIDR(user.balance)}`);
        userStates.delete(chatId);
        return;
      }
      state.amount = amount;
      state.action = "awaiting_wd_account";
      activeBot.sendMessage(chatId, `Silakan masukkan NOMOR REKENING atau NOMOR E-WALLET tujuan:`, cancelMenu);
    }

    // Handle Withdrawal Account
    else if (state.action === "awaiting_wd_account") {
      const account = msg.text;
      if (!account) return;
      
      (state as any).wdAccount = account;
      state.action = "awaiting_wd_name";
      activeBot.sendMessage(chatId, `Silakan masukkan NAMA PENERIMA (sesuai nama di rekening/e-wallet):`, cancelMenu);
    }

    // Handle Withdrawal Name
    else if (state.action === "awaiting_wd_name") {
      const wdName = msg.text;
      if (!wdName) return;

      const details = `No: ${(state as any).wdAccount}\nNama: ${wdName}`;
      const txId = db.prepare("INSERT INTO transactions (user_id, type, amount, method, details) VALUES (?, ?, ?, ?, ?)").run(
        chatId, 'withdraw', state.amount, state.method, details
      ).lastInsertRowid;

      db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(state.amount, chatId);

      activeBot.sendMessage(chatId, "⏳ <b>Permintaan penarikan Anda sedang diproses.</b>\n\nMohon tunggu verifikasi dari admin. Anda akan menerima notifikasi setelah dana dikirim.", { parse_mode: "HTML", ...mainMenu });
      
      if (adminChatId) {
        activeBot.sendMessage(adminChatId, 
          `🔔 <b>PERMINTAAN WD BARU</b>\n\n` +
          `ID Transaksi: #${txId}\n` +
          `User: @${msg.from?.username || chatId}\n` +
          `Nominal: <b>${formatIDR(state.amount!)}</b>\n` +
          `Metode: <b>${state.method}</b>\n` +
          `No Rek/E-wallet: <code>${(state as any).wdAccount}</code>\n` +
          `Nama Penerima: <b>${wdName}</b>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "Setujui ✅", callback_data: `approve_${txId}` }, { text: "Tolak ❌", callback_data: `reject_${txId}` }]
              ]
            }
          }
        );
      }
      userStates.delete(chatId);
    }

    // Handle Buy Token Amount
    else if (state.action === "awaiting_buy_bnb_amount") {
      const amount = parseFloat(msg.text || "");
      if (isNaN(amount) || amount <= 0) {
        activeBot.sendMessage(chatId, `Jumlah ${(state as any).tokenType} tidak valid. Silakan masukkan angka:`);
        return;
      }
      const tokenType = (state as any).tokenType;
      const rate = tokenType === "BNB" ? bnbBuyRate : usdtBuyRate;
      const cost = Math.ceil(amount * rate);
      const user = getUser(chatId);
      
      if (user.balance < cost) {
        activeBot.sendMessage(chatId, `❌ Saldo Anda tidak cukup.\nBiaya: *${formatIDR(cost)}*\nSaldo Anda: *${formatIDR(user.balance)}*\n\nSilakan Topup terlebih dahulu.`, { parse_mode: "Markdown" });
        userStates.delete(chatId);
        return;
      }

      state.amount = cost;
      (state as any).bnbAmount = amount;
      state.action = "awaiting_buy_bnb_wallet";
      activeBot.sendMessage(chatId, `Total Biaya: *${formatIDR(cost)}*\n\nSilakan masukkan *Alamat Wallet Penerima* (Token akan dikirim ke sini):`, { parse_mode: "Markdown", ...cancelMenu });
    }

    // Handle Buy Token Wallet
    else if (state.action === "awaiting_buy_bnb_wallet") {
      const wallet = msg.text?.trim();
      if (!wallet || !wallet.startsWith("0x") || wallet.length !== 42) {
        activeBot.sendMessage(chatId, "Alamat wallet tidak valid. Pastikan diawali dengan '0x' dan memiliki panjang yang benar:", cancelMenu);
        return;
      }
      
      const tokenAmount = (state as any).bnbAmount;
      const tokenType = (state as any).tokenType;
      const cost = state.amount!;
      
      activeBot.sendMessage(chatId, `⏳ Sedang memproses pengiriman *${tokenAmount} ${tokenType}* ke \`${wallet}\`...`, { parse_mode: "Markdown" });

      try {
        if (!hotWallet) throw new Error("Hot wallet not initialized");

        let txHash = "";
        if (tokenType === "BNB") {
          const tx = await hotWallet.sendTransaction({
            to: wallet,
            value: ethers.parseEther(tokenAmount.toString())
          });
          txHash = tx.hash;
        } else {
          // USDT BEP20
          const usdtContract = new ethers.Contract(usdtContractAddress, ERC20_ABI, hotWallet);
          // Assuming 18 decimals for testnet USDT
          const amountWei = ethers.parseUnits(tokenAmount.toString(), 18);
          const tx = await usdtContract.transfer(wallet, amountWei);
          txHash = tx.hash;
        }

        // Deduct balance
        db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(cost, chatId);

        // Record transaction
        const txId = db.prepare("INSERT INTO transactions (user_id, type, amount, method, tx_hash, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          chatId, 'withdraw', cost, state.method, txHash, 'approved', `Buy ${tokenType}: ${tokenAmount}\nTo: ${wallet}`
        ).lastInsertRowid;

        activeBot.sendMessage(chatId, 
          `✅ *PEMBELIAN ${tokenType} BERHASIL!*\n\n` +
          `Detail Pembelian:\n` +
          `• Jumlah: *${tokenAmount} ${tokenType}*\n` +
          `• Biaya: *${formatIDR(cost)}*\n` +
          `• Tujuan: \`${wallet}\`\n` +
          `• TXID: \`${txHash}\`\n\n` +
          `${tokenType} telah dikirim dari Hot Wallet kami.`, 
          { parse_mode: "Markdown", ...mainMenu }
        );

        if (adminChatId) {
          activeBot.sendMessage(adminChatId, 
            `🤖 *AUTO-SEND ${tokenType} PURCHASE*\n\n` +
            `ID Transaksi: #${txId}\n` +
            `User: @${msg.from?.username || chatId}\n` +
            `${tokenType} Dikirim: *${tokenAmount} ${tokenType}*\n` +
            `Biaya IDR: *${formatIDR(cost)}*\n` +
            `Tujuan: \`${wallet}\`\n` +
            `TXID: \`${txHash}\``,
            { parse_mode: "Markdown" }
          );
        }
        userStates.delete(chatId);

      } catch (error: any) {
        console.error(`Buy ${tokenType} Error:`, error);
        let errorMsg = `❌ Terjadi kesalahan saat mengirim ${tokenType}. Silakan hubungi admin.`;
        if (error.message?.includes("insufficient funds")) {
          errorMsg = `❌ Hot Wallet admin kehabisan saldo ${tokenType}. Silakan hubungi admin untuk isi ulang.`;
        }
        activeBot.sendMessage(chatId, errorMsg);
        userStates.delete(chatId);
      }
    }
  } catch (err: any) {
      console.error(`❌ [BOT] Error in message handler:`, err);
      try {
        await activeBot.sendMessage(msg.chat.id, "❌ Terjadi kesalahan internal pada bot. Silakan coba lagi nanti.");
      } catch (sendErr) {
        console.error(`❌ [BOT] Failed to send error message:`, sendErr);
      }
    }
  });

  // Handle Photo Upload for Topup Proof
  activeBot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);

    if (state && state.action === "awaiting_topup_proof") {
      const photo = msg.photo?.[msg.photo.length - 1];
      if (!photo) return;

      const details = `Pengirim: ${(state as any).senderName}`;
      const txId = db.prepare("INSERT INTO transactions (user_id, type, amount, method, file_id, details) VALUES (?, ?, ?, ?, ?, ?)").run(
        chatId, 'topup', state.amount, state.method, photo.file_id, details
      ).lastInsertRowid;

      activeBot.sendMessage(chatId, "✅ <b>Bukti transfer telah diterima.</b>\n\nAdmin akan segera memverifikasi pembayaran Anda. Saldo akan otomatis bertambah setelah disetujui.", { parse_mode: "HTML", ...mainMenu });

      if (adminChatId) {
        activeBot.sendPhoto(adminChatId, photo.file_id, {
          caption: `🔔 <b>TOPUP BARU</b>\n\n` +
                   `ID Transaksi: #${txId}\n` +
                   `User: @${msg.from?.username || chatId}\n` +
                   `Nominal: <b>${formatIDR(state.amount!)}</b>\n` +
                   `Metode: <b>${state.method}</b>\n` +
                   `Nama Pengirim: <b>${(state as any).senderName}</b>`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Setujui ✅", callback_data: `approve_${txId}` }, { text: "Tolak ❌", callback_data: `reject_${txId}` }]
            ]
          }
        });
      }
      userStates.delete(chatId);
    }
  });
}

// --- Express Server Setup ---
async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request Logger
  app.use((req, res, next) => {
    console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // API Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", bot: !!token });
  });

  // Root Debug Route
  app.get("/debug", (req, res) => {
    res.send("<h1>Server is Running</h1><p>If you see this, the Express server is alive.</p>");
  });

  // Bot Status Check
  app.get("/api/bot-status", async (req, res) => {
    if (!bot) {
      return res.status(500).json({ 
        error: "Bot not initialized.",
        env: {
          hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
          hasAdminId: !!process.env.ADMIN_CHAT_ID
        }
      });
    }
    try {
      const me = await bot.getMe();
      res.json({ 
        status: "connected", 
        bot: me,
        env: {
          hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
          hasAdminId: !!process.env.ADMIN_CHAT_ID,
          adminId: process.env.ADMIN_CHAT_ID ? `${process.env.ADMIN_CHAT_ID.substring(0, 3)}***` : "MISSING"
        }
      });
    } catch (error: any) {
      console.error("Bot Status Error:", error);
      res.status(500).json({ 
        status: "error", 
        message: error.message,
        env: {
          hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
          hasAdminId: !!process.env.ADMIN_CHAT_ID
        }
      });
    }
  });

  // Test Send Message
  app.get("/api/test-bot", async (req, res) => {
    if (!bot || !adminChatId) {
      return res.status(400).json({ error: "Bot or Admin ID not configured" });
    }
    try {
      await bot.sendMessage(adminChatId, "🧪 <b>TEST MESSAGE</b>\n\nJika Anda menerima ini, bot berhasil mengirim pesan ke Admin.", { parse_mode: "HTML" });
      res.json({ success: true, message: "Test message sent to admin" });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    console.log("🛠️ Starting Vite...");
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
        logLevel: "silent",
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.error("❌ Vite error:", err);
    }
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    initBot();
  });

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("🚨 Server Error:", err.message);
    res.status(500).send("Something went wrong.");
  });
}

startServer();
