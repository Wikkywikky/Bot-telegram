import os
import sqlite3
import time
import threading
import requests
import telebot
from telebot import types
from web3 import Web3
from decimal import Decimal
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID")
BNB_ADMIN_ADDRESS = (os.getenv("BNB_TESTNET_ADDRESS") or "0x0000000000000000000000000000000000000000").lower()
HOT_WALLET_PRIVATE_KEY = os.getenv("HOT_WALLET_PRIVATE_KEY")
USDT_CONTRACT_ADDRESS = os.getenv("USDT_CONTRACT_ADDRESS") or "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd"

# BSC Testnet Provider
BSC_RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/"
w3 = Web3(Web3.HTTPProvider(BSC_RPC_URL))

# ERC20 ABI (Minimal)
ERC20_ABI = [
    {
        "constant": False,
        "inputs": [{"name": "_to", "type": "address"}, {"name": "_value", "type": "uint256"}],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "type": "function",
    }
]

# Database Setup
def init_db():
    conn = sqlite3.connect("bot_database.db", check_same_thread=False)
    cursor = conn.cursor()
    cursor.executescript("""
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
    """)
    
    # Default Settings
    defaults = [
        ('maintenance_jual', 'false'),
        ('maintenance_beli', 'false'),
        ('maintenance_topup', 'false'),
        ('maintenance_wd', 'false'),
        ('acc_OVO', '081234567890'), ('name_OVO', 'ADMIN OVO'),
        ('acc_DANA', '081234567890'), ('name_DANA', 'ADMIN DANA'),
        ('acc_GOPAY', '081234567890'), ('name_GOPAY', 'ADMIN GOPAY'),
        ('acc_BCA', '1234567890'), ('name_BCA', 'ADMIN BCA'),
        ('acc_BRI', '1234567890'), ('name_BRI', 'ADMIN BRI'),
        ('acc_MANDIRI', '1234567890'), ('name_MANDIRI', 'ADMIN MANDIRI'),
        ('status_topup_OVO', 'true'), ('status_topup_DANA', 'true'), ('status_topup_GOPAY', 'true'),
        ('status_topup_BCA', 'true'), ('status_topup_BRI', 'true'), ('status_topup_MANDIRI', 'true'),
        ('status_wd_OVO', 'true'), ('status_wd_DANA', 'true'), ('status_wd_GOPAY', 'true'),
        ('status_wd_BCA', 'true'), ('status_wd_BRI', 'true'), ('status_wd_MANDIRI', 'true')
    ]
    for key, val in defaults:
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, val))
    
    conn.commit()
    return conn

db_conn = init_db()

# Global Rates
bnb_rate = 10000
bnb_buy_rate = 11000
usdt_rate = 15000
usdt_buy_rate = 16000

def update_rates():
    global bnb_rate, bnb_buy_rate, usdt_rate, usdt_buy_rate
    while True:
        try:
            response = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin,tether&vs_currencies=idr")
            data = response.json()
            if 'binancecoin' in data:
                bnb_rate = int(data['binancecoin']['idr'])
                bnb_buy_rate = int(bnb_rate * 1.1)
            if 'tether' in data:
                usdt_rate = int(data['tether']['idr'])
                usdt_buy_rate = int(usdt_rate * 1.05)
            print(f"📊 Rates Updated - BNB: {bnb_rate}, USDT: {usdt_rate}")
        except Exception as e:
            print(f"❌ Error fetching prices: {e}")
        time.sleep(300)

threading.Thread(target=update_rates, daemon=True).start()

# Bot Initialization
bot = telebot.TeleBot(TOKEN)
user_states = {}

# Helpers
def get_user(user_id, username=None):
    cursor = db_conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        cursor.execute("INSERT INTO users (id, username, balance) VALUES (?, ?, ?)", (user_id, username or "Unknown", 0))
        db_conn.commit()
        return {"id": user_id, "username": username or "Unknown", "balance": 0}
    
    if username and user[1] != username:
        cursor.execute("UPDATE users SET username = ? WHERE id = ?", (username, user_id))
        db_conn.commit()
        return {"id": user_id, "username": username, "balance": user[2]}
    
    return {"id": user[0], "username": user[1], "balance": user[2]}

def format_idr(amount):
    return f"Rp {amount:,.0f}".replace(",", ".")

def get_setting(key, default=None):
    cursor = db_conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
    res = cursor.fetchone()
    return res[0] if res else default

def set_setting(key, value):
    cursor = db_conn.cursor()
    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    db_conn.commit()

# Keyboards
def get_main_menu():
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.row("🚀 BELI TOKEN", "💎 JUAL TOKEN")
    markup.row("💳 TOPUP SALDO", "💸 TARIK SALDO (WD)")
    markup.row("👤 PROFIL & SALDO", "📊 RIWAYAT")
    return markup

def get_cancel_menu():
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.add("❌ BATALKAN PROSES")
    return markup

# --- Bot Handlers ---

@bot.message_id_handler(commands=['start'])
def start(message):
    get_user(message.from_user.id, message.from_user.username)
    text = (
        "👋 <b>Selamat Datang di IDR Payment Bot!</b>\n\n"
        "Kami menyediakan layanan pertukaran aset digital (Crypto) ke Rupiah secara aman dan instan.\n\n"
        "🚀 <b>Fitur Utama:</b>\n"
        "• Beli & Jual Token (BNB/USDT)\n"
        "• Topup & Tarik Saldo (WD)\n"
        "• Verifikasi Otomatis & Manual\n\n"
        "Silakan pilih menu di bawah untuk memulai transaksi Anda."
    )
    bot.send_message(message.chat.id, text, parse_mode="HTML", reply_markup=get_main_menu())

@bot.message_handler(func=lambda m: m.text == "❌ BATALKAN PROSES")
def cancel(message):
    user_states.pop(message.chat.id, None)
    bot.send_message(message.chat.id, "🔄 <b>Proses Dibatalkan.</b>\nKembali ke menu utama.", parse_mode="HTML", reply_markup=get_main_menu())

@bot.message_handler(func=lambda m: m.text == "👤 PROFIL & SALDO")
def profile(message):
    user = get_user(message.from_user.id, message.from_user.username)
    text = (
        f"👤 <b>PROFIL PENGGUNA</b>\n\n"
        f"Username: @{user['username']}\n"
        f"ID: <code>{user['id']}</code>\n"
        f"Saldo Aktif: <b>{format_idr(user['balance'])}</b>"
    )
    bot.send_message(message.chat.id, text, parse_mode="HTML")

@bot.message_handler(func=lambda m: m.text == "📊 RIWAYAT")
def history(message):
    cursor = db_conn.cursor()
    cursor.execute("SELECT type, amount, method, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5", (message.chat.id,))
    txs = cursor.fetchall()
    if not txs:
        bot.send_message(message.chat.id, "Belum ada riwayat transaksi.")
        return
    
    res = "<b>5 Transaksi Terakhir:</b>\n\n"
    for t in txs:
        emoji = "✅" if t[3] == 'approved' else ("❌" if t[3] == 'rejected' else "⏳")
        res += f"{emoji} {t[0].upper()} - {format_idr(t[1])}\nMethod: {t[2]}\nStatus: {t[3]}\nTanggal: {t[4]}\n\n"
    bot.send_message(message.chat.id, res, parse_mode="HTML")

# --- Topup Logic ---
@bot.message_handler(func=lambda m: m.text == "💳 TOPUP SALDO")
def topup_start(message):
    if get_setting('maintenance_topup') == 'true':
        bot.send_message(message.chat.id, "⚠️ Fitur Topup sedang Maintenance.")
        return
    
    methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"]
    enabled = [m for m in methods if get_setting(f'status_topup_{m}') == 'true']
    
    if not enabled:
        bot.send_message(message.chat.id, "⚠️ Tidak ada metode topup tersedia.")
        return
    
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    for i in range(0, len(enabled), 2):
        row = [f"📱 {enabled[i]} (Topup)" if enabled[i] in ["OVO", "DANA", "GOPAY"] else f"🏦 {enabled[i]} (Topup)"]
        if i+1 < len(enabled):
            row.append(f"📱 {enabled[i+1]} (Topup)" if enabled[i+1] in ["OVO", "DANA", "GOPAY"] else f"🏦 {enabled[i+1]} (Topup)")
        markup.row(*row)
    markup.add("❌ BATALKAN PROSES")
    
    bot.send_message(message.chat.id, "💳 <b>METODE PEMBAYARAN TOPUP</b>\n\nSilakan pilih metode:", parse_mode="HTML", reply_markup=markup)
    user_states[message.chat.id] = {"action": "selecting_topup_method"}

# (Simplified state handling for brevity, similar logic to TS)
@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "selecting_topup_method")
def topup_method(message):
    method = message.text.replace("📱 ", "").replace("🏦 ", "").replace(" (Topup)", "").upper()
    user_states[message.chat.id] = {"action": "awaiting_topup_amount", "method": method}
    bot.send_message(message.chat.id, f"✅ <b>METODE TERPILIH: {method}</b>\n\nMasukkan nominal (angka saja):", parse_mode="HTML", reply_markup=get_cancel_menu())

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_topup_amount")
def topup_amount(message):
    try:
        amount = int(message.text)
        if amount < 1000: raise ValueError
        user_states[message.chat.id].update({"action": "awaiting_topup_sender_name", "amount": amount})
        bot.send_message(message.chat.id, "Masukkan NAMA PENGIRIM:")
    except:
        bot.send_message(message.chat.id, "Nominal tidak valid (Min Rp 1.000).")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_topup_sender_name")
def topup_sender(message):
    state = user_states[message.chat.id]
    state.update({"action": "awaiting_topup_proof", "sender_name": message.text})
    acc = get_setting(f"acc_{state['method']}", "081234567890")
    name = get_setting(f"name_{state['method']}", "ADMIN")
    bot.send_message(message.chat.id, f"Transfer {format_idr(state['amount'])} ke:\n\n<b>{state['method']} Admin:</b> <code>{acc}</code>\na/n <b>{name}</b>\n\nKirim FOTO BUKTI TRANSFER:", parse_mode="HTML")

@bot.message_handler(content_types=['photo'], func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_topup_proof")
def topup_proof(message):
    state = user_states.pop(message.chat.id)
    file_id = message.photo[-1].file_id
    details = f"Pengirim: {state['sender_name']}"
    
    cursor = db_conn.cursor()
    cursor.execute("INSERT INTO transactions (user_id, type, amount, method, file_id, details) VALUES (?, ?, ?, ?, ?, ?)",
                   (message.chat.id, 'topup', state['amount'], state['method'], file_id, details))
    tx_id = cursor.lastrowid
    db_conn.commit()
    
    bot.send_message(message.chat.id, "✅ Bukti diterima. Menunggu verifikasi admin.", reply_markup=get_main_menu())
    
    if ADMIN_CHAT_ID:
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton("Setujui ✅", callback_data=f"approve_{tx_id}"),
                   types.InlineKeyboardButton("Tolak ❌", callback_data=f"reject_{tx_id}"))
        bot.send_photo(ADMIN_CHAT_ID, file_id, 
                       caption=f"🔔 <b>TOPUP BARU #{tx_id}</b>\nUser: @{message.from_user.username}\nNominal: {format_idr(state['amount'])}\nMetode: {state['method']}\nNama: {state['sender_name']}",
                       parse_mode="HTML", reply_markup=markup)

# --- Admin Handlers ---
@bot.callback_query_handler(func=lambda q: q.data.startswith(("approve_", "reject_")))
def admin_process(query):
    if str(query.from_user.id) != str(ADMIN_CHAT_ID):
        bot.answer_callback_query(query.id, "Unauthorized")
        return
    
    action, tx_id = query.data.split("_")
    cursor = db_conn.cursor()
    cursor.execute("SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.id = ?", (tx_id,))
    tx = cursor.fetchone()
    
    if not tx or tx[5] != 'pending':
        bot.answer_callback_query(query.id, "Sudah diproses.")
        return
    
    status = 'approved' if action == 'approve' else 'rejected'
    cursor.execute("UPDATE transactions SET status = ? WHERE id = ?", (status, tx_id))
    
    if tx[2] == 'topup' and action == 'approve':
        cursor.execute("UPDATE users SET balance = balance + ? WHERE id = ?", (tx[3], tx[1]))
        bot.send_message(tx[1], f"✅ Topup {format_idr(tx[3])} DISETUJUI.")
    elif tx[2] == 'withdraw' and action == 'reject':
        cursor.execute("UPDATE users SET balance = balance + ? WHERE id = ?", (tx[3], tx[1]))
        bot.send_message(tx[1], f"❌ WD {format_idr(tx[3])} DITOLAK. Saldo dikembalikan.")
    elif action == 'reject':
        bot.send_message(tx[1], f"❌ Transaksi {format_idr(tx[3])} DITOLAK.")
    elif tx[2] == 'withdraw' and action == 'approve':
        bot.send_message(tx[1], f"✅ WD {format_idr(tx[3])} DISETUJUI.")

    db_conn.commit()
    bot.edit_message_caption(f"Transaksi #{tx_id} {'DISETUJUI' if action == 'approve' else 'DITOLAK'}", query.message.chat.id, query.message.message_id)
    bot.answer_callback_query(query.id, "Berhasil!")

# --- Withdrawal Logic ---
@bot.message_handler(func=lambda m: m.text == "💸 TARIK SALDO (WD)")
def wd_start(message):
    if get_setting('maintenance_wd') == 'true':
        bot.send_message(message.chat.id, "⚠️ Fitur WD sedang Maintenance.")
        return
    
    methods = ["OVO", "DANA", "GOPAY", "BCA", "BRI", "MANDIRI"]
    enabled = [m for m in methods if get_setting(f'status_wd_{m}') == 'true']
    
    if not enabled:
        bot.send_message(message.chat.id, "⚠️ Tidak ada metode WD tersedia.")
        return
    
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    for i in range(0, len(enabled), 2):
        row = [f"📱 {enabled[i]} (WD)" if enabled[i] in ["OVO", "DANA", "GOPAY"] else f"🏦 {enabled[i]} (WD)"]
        if i+1 < len(enabled):
            row.append(f"📱 {enabled[i+1]} (WD)" if enabled[i+1] in ["OVO", "DANA", "GOPAY"] else f"🏦 {enabled[i+1]} (WD)")
        markup.row(*row)
    markup.add("❌ BATALKAN PROSES")
    
    bot.send_message(message.chat.id, "💸 <b>METODE PENARIKAN SALDO</b>\n\nSilakan pilih tujuan:", parse_mode="HTML", reply_markup=markup)
    user_states[message.chat.id] = {"action": "selecting_wd_method"}

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "selecting_wd_method")
def wd_method(message):
    method = message.text.replace("📱 ", "").replace("🏦 ", "").replace(" (WD)", "").upper()
    user_states[message.chat.id] = {"action": "awaiting_wd_amount", "method": method}
    bot.send_message(message.chat.id, f"✅ <b>TUJUAN WD: {method}</b>\n\nMasukkan nominal WD (angka saja):", parse_mode="HTML", reply_markup=get_cancel_menu())

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_wd_amount")
def wd_amount(message):
    try:
        amount = int(message.text)
        user = get_user(message.chat.id)
        if amount < 10000:
            bot.send_message(message.chat.id, "Minimal WD Rp 10.000.")
            return
        if amount > user['balance']:
            bot.send_message(message.chat.id, f"Saldo tidak cukup. Saldo Anda: {format_idr(user['balance'])}")
            return
        
        user_states[message.chat.id].update({"action": "awaiting_wd_account", "amount": amount})
        bot.send_message(message.chat.id, "Masukkan NOMOR REKENING/E-WALLET tujuan:")
    except:
        bot.send_message(message.chat.id, "Nominal tidak valid.")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_wd_account")
def wd_account(message):
    user_states[message.chat.id].update({"action": "awaiting_wd_name", "wd_account": message.text})
    bot.send_message(message.chat.id, "Masukkan NAMA PENERIMA:")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_wd_name")
def wd_name(message):
    state = user_states.pop(message.chat.id)
    wd_name = message.text
    details = f"No: {state['wd_account']}\nNama: {wd_name}"
    
    cursor = db_conn.cursor()
    cursor.execute("INSERT INTO transactions (user_id, type, amount, method, details) VALUES (?, ?, ?, ?, ?)",
                   (message.chat.id, 'withdraw', state['amount'], state['method'], details))
    tx_id = cursor.lastrowid
    cursor.execute("UPDATE users SET balance = balance - ? WHERE id = ?", (state['amount'], message.chat.id))
    db_conn.commit()
    
    bot.send_message(message.chat.id, "⏳ Permintaan WD sedang diproses admin.", reply_markup=get_main_menu())
    
    if ADMIN_CHAT_ID:
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton("Setujui ✅", callback_data=f"approve_{tx_id}"),
                   types.InlineKeyboardButton("Tolak ❌", callback_data=f"reject_{tx_id}"))
        bot.send_message(ADMIN_CHAT_ID, 
                         f"🔔 <b>WD BARU #{tx_id}</b>\nUser: @{message.from_user.username}\nNominal: {format_idr(state['amount'])}\nMetode: {state['method']}\nNo: {state['wd_account']}\nNama: {wd_name}",
                         parse_mode="HTML", reply_markup=markup)

# --- Jual Token Logic ---
@bot.message_handler(func=lambda m: m.text == "💎 JUAL TOKEN")
def jual_start(message):
    if get_setting('maintenance_jual') == 'true':
        bot.send_message(message.chat.id, "⚠️ Fitur Jual sedang Maintenance.")
        return
    
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.row("🪙 BNB Testnet (Jual)", "💵 USDT BEP20 (Jual)")
    markup.add("❌ BATALKAN PROSES")
    bot.send_message(message.chat.id, "Pilih aset yang ingin dijual:", reply_markup=markup)
    user_states[message.chat.id] = {"action": "selecting_token_jual"}

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "selecting_token_jual")
def jual_token_select(message):
    token_type = "BNB" if "BNB" in message.text else "USDT"
    rate = bnb_rate if token_type == "BNB" else usdt_rate
    user_states[message.chat.id] = {"action": "awaiting_jual_amount", "token_type": token_type, "rate": rate}
    bot.send_message(message.chat.id, f"Jual {token_type}.\nRate: 1 {token_type} = {format_idr(rate)}\n\nMasukkan jumlah {token_type} (misal: 0.5):", reply_markup=get_cancel_menu())

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_jual_amount")
def jual_amount(message):
    try:
        amount = float(message.text)
        state = user_states[message.chat.id]
        idr_amount = int(amount * state['rate'])
        state.update({"action": "awaiting_jual_wallet", "token_amount": amount, "idr_amount": idr_amount})
        bot.send_message(message.chat.id, f"Masukkan Alamat Wallet PENGIRIM (Alamat Anda):")
    except:
        bot.send_message(message.chat.id, "Jumlah tidak valid.")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_jual_wallet")
def jual_wallet(message):
    wallet = message.text.strip()
    if not wallet.startswith("0x") or len(wallet) != 42:
        bot.send_message(message.chat.id, "Wallet tidak valid.")
        return
    
    state = user_states[message.chat.id]
    state.update({"action": "awaiting_jual_txid", "sender_wallet": wallet})
    bot.send_message(message.chat.id, 
                     f"Kirim {state['token_amount']} {state['token_type']} ke:\n\n<code>{BNB_ADMIN_ADDRESS}</code>\n\nKirim TXID / Hash Transaksi di sini:",
                     parse_mode="HTML")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_jual_txid")
def jual_txid(message):
    txid = message.text.strip()
    state = user_states.pop(message.chat.id)
    bot.send_message(message.chat.id, "⏳ Memverifikasi transaksi... (Manual oleh admin dalam versi ini)")
    
    cursor = db_conn.cursor()
    cursor.execute("INSERT INTO transactions (user_id, type, amount, method, tx_hash, details) VALUES (?, ?, ?, ?, ?, ?)",
                   (message.chat.id, 'topup', state['idr_amount'], state['token_type'], txid, f"Jual {state['token_type']}: {state['token_amount']}\nFrom: {state['sender_wallet']}"))
    tx_id = cursor.lastrowid
    db_conn.commit()
    
    if ADMIN_CHAT_ID:
        markup = types.InlineKeyboardMarkup()
        markup.row(types.InlineKeyboardButton("Setujui ✅", callback_data=f"approve_{tx_id}"),
                   types.InlineKeyboardButton("Tolak ❌", callback_data=f"reject_{tx_id}"))
        bot.send_message(ADMIN_CHAT_ID, 
                         f"🔔 <b>JUAL TOKEN BARU #{tx_id}</b>\nUser: @{message.from_user.username}\nToken: {state['token_type']}\nJumlah: {state['token_amount']}\nHasil IDR: {format_idr(state['idr_amount'])}\nTXID: <code>{txid}</code>",
                         parse_mode="HTML", reply_markup=markup)

# --- Beli Token Logic ---
@bot.message_handler(func=lambda m: m.text == "🚀 BELI TOKEN")
def beli_start(message):
    if get_setting('maintenance_beli') == 'true':
        bot.send_message(message.chat.id, "⚠️ Fitur Beli sedang Maintenance.")
        return
    
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True)
    markup.row("🪙 BNB Testnet (Beli)", "💵 USDT BEP20 (Beli)")
    markup.add("❌ BATALKAN PROSES")
    bot.send_message(message.chat.id, "Pilih aset yang ingin dibeli:", reply_markup=markup)
    user_states[message.chat.id] = {"action": "selecting_token_beli"}

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "selecting_token_beli")
def beli_token_select(message):
    token_type = "BNB" if "BNB" in message.text else "USDT"
    rate = bnb_buy_rate if token_type == "BNB" else usdt_buy_rate
    user_states[message.chat.id] = {"action": "awaiting_beli_amount", "token_type": token_type, "rate": rate}
    bot.send_message(message.chat.id, f"Beli {token_type}.\nRate: 1 {token_type} = {format_idr(rate)}\n\nMasukkan jumlah {token_type} (misal: 0.1):", reply_markup=get_cancel_menu())

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_beli_amount")
def beli_amount(message):
    try:
        amount = float(message.text)
        state = user_states[message.chat.id]
        cost = int(amount * state['rate'])
        user = get_user(message.chat.id)
        
        if user['balance'] < cost:
            bot.send_message(message.chat.id, f"Saldo tidak cukup. Biaya: {format_idr(cost)}\nSaldo Anda: {format_idr(user['balance'])}")
            return
        
        state.update({"action": "awaiting_beli_wallet", "token_amount": amount, "cost": cost})
        bot.send_message(message.chat.id, f"Biaya: {format_idr(cost)}\n\nMasukkan Alamat Wallet PENERIMA (Token akan dikirim ke sini):")
    except:
        bot.send_message(message.chat.id, "Jumlah tidak valid.")

@bot.message_handler(func=lambda m: user_states.get(m.chat.id, {}).get("action") == "awaiting_beli_wallet")
def beli_wallet(message):
    wallet = message.text.strip()
    if not wallet.startswith("0x") or len(wallet) != 42:
        bot.send_message(message.chat.id, "Wallet tidak valid.")
        return
    
    state = user_states.pop(message.chat.id)
    bot.send_message(message.chat.id, f"⏳ Sedang memproses pengiriman {state['token_amount']} {state['token_type']}...")
    
    try:
        if not HOT_WALLET_PRIVATE_KEY:
            raise Exception("Hot Wallet not configured")
        
        # Web3 Transaction Logic
        account = w3.eth.account.from_key(HOT_WALLET_PRIVATE_KEY)
        nonce = w3.eth.get_transaction_count(account.address)
        
        if state['token_type'] == "BNB":
            tx = {
                'nonce': nonce,
                'to': wallet,
                'value': w3.to_wei(state['token_amount'], 'ether'),
                'gas': 21000,
                'gasPrice': w3.eth.gas_price,
                'chainId': 97 # BSC Testnet
            }
        else:
            # USDT BEP20
            contract = w3.eth.contract(address=USDT_CONTRACT_ADDRESS, abi=ERC20_ABI)
            # Assuming 18 decimals for testnet USDT
            amount_wei = int(state['token_amount'] * 10**18)
            tx = contract.functions.transfer(wallet, amount_wei).build_transaction({
                'chainId': 97,
                'gas': 100000,
                'gasPrice': w3.eth.gas_price,
                'nonce': nonce,
            })
            
        signed_tx = w3.eth.account.sign_transaction(tx, HOT_WALLET_PRIVATE_KEY)
        tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
        tx_hash_hex = w3.to_hex(tx_hash)
        
        # Deduct Balance
        cursor = db_conn.cursor()
        cursor.execute("UPDATE users SET balance = balance - ? WHERE id = ?", (state['cost'], message.chat.id))
        
        # Record Transaction
        cursor.execute("INSERT INTO transactions (user_id, type, amount, method, tx_hash, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (message.chat.id, 'withdraw', state['cost'], state['token_type'], tx_hash_hex, 'approved', f"Buy {state['token_type']}: {state['token_amount']}\nTo: {wallet}"))
        tx_id = cursor.lastrowid
        db_conn.commit()
        
        bot.send_message(message.chat.id, 
                         f"✅ <b>PEMBELIAN BERHASIL!</b>\n\nJumlah: {state['token_amount']} {state['token_type']}\nBiaya: {format_idr(state['cost'])}\nTujuan: <code>{wallet}</code>\nTXID: <code>{tx_hash_hex}</code>",
                         parse_mode="HTML", reply_markup=get_main_menu())
        
        if ADMIN_CHAT_ID:
            bot.send_message(ADMIN_CHAT_ID, f"🤖 <b>AUTO-SEND PURCHASE #{tx_id}</b>\nUser: @{message.from_user.username}\nToken: {state['token_type']}\nJumlah: {state['token_amount']}\nTXID: <code>{tx_hash_hex}</code>", parse_mode="HTML")
            
    except Exception as e:
        bot.send_message(message.chat.id, f"❌ Gagal memproses pengiriman: {str(e)}")

# --- Admin Panel ---
@bot.message_handler(commands=['admin'])
def admin_panel(message):
    if str(message.chat.id) != str(ADMIN_CHAT_ID): return
    
    cursor = db_conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM users")
    total_users = cursor.fetchone()[0]
    cursor.execute("SELECT SUM(balance) FROM users")
    total_balance = cursor.fetchone()[0] or 0
    
    report = f"📊 <b>LAPORAN ADMIN</b>\n\nTotal User: {total_users}\nTotal Saldo: {format_idr(total_balance)}\n\n"
    
    markup = types.InlineKeyboardMarkup()
    m_jual = get_setting('maintenance_jual') == 'true'
    m_beli = get_setting('maintenance_beli') == 'true'
    m_topup = get_setting('maintenance_topup') == 'true'
    m_wd = get_setting('maintenance_wd') == 'true'
    
    markup.row(types.InlineKeyboardButton(f"Jual: {'🔴 OFF' if m_jual else '🟢 ON'}", callback_data="toggle_m_jual"),
               types.InlineKeyboardButton(f"Beli: {'🔴 OFF' if m_beli else '🟢 ON'}", callback_data="toggle_m_beli"))
    markup.row(types.InlineKeyboardButton(f"Topup: {'🔴 OFF' if m_topup else '🟢 ON'}", callback_data="toggle_m_topup"),
               types.InlineKeyboardButton(f"WD: {'🔴 OFF' if m_wd else '🟢 ON'}", callback_data="toggle_m_wd"))
    
    bot.send_message(message.chat.id, report + "Pengaturan Maintenance:", parse_mode="HTML", reply_markup=markup)

@bot.callback_query_handler(func=lambda q: q.data.startswith("toggle_m_"))
def admin_toggle(query):
    key = query.data.replace("toggle_", "")
    current = get_setting(key) == 'true'
    set_setting(key, 'false' if current else 'true')
    bot.answer_callback_query(query.id, "Status Diperbarui")
    admin_panel(query.message) # Refresh

# Start Polling
if __name__ == "__main__":
    print("🚀 Bot is running...")
    bot.infinity_polling()
