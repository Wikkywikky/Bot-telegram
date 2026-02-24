import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Bot, ShieldCheck, Wallet, ArrowUpCircle, ArrowDownCircle, RefreshCcw, CheckCircle2, XCircle } from "lucide-react";

export default function App() {
  const [status, setStatus] = useState<{ status: string, bot?: any, env?: any } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bot-status");
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ status: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Hero Section */}
      <div className="max-w-4xl mx-auto px-6 py-20">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center space-y-6"
        >
          <div className="inline-flex items-center justify-center p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20 mb-4">
            <Bot className="w-8 h-8 text-emerald-500" />
          </div>
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-white">
            IDR Payment <span className="text-emerald-500">Bot</span>
          </h1>
          <p className="text-xl text-zinc-400 max-w-2xl mx-auto">
            Sistem bot Telegram otomatis untuk manajemen saldo IDR dengan verifikasi admin yang aman.
          </p>

          {/* Status Badge */}
          <div className="flex justify-center pt-4">
            <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border ${
              loading ? "bg-zinc-900 border-zinc-800 text-zinc-400" :
              status?.status === "connected" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500" :
              "bg-red-500/10 border-red-500/20 text-red-500"
            }`}>
              {loading ? <RefreshCcw className="w-4 h-4 animate-spin" /> : 
               status?.status === "connected" ? <CheckCircle2 className="w-4 h-4" /> : 
               <XCircle className="w-4 h-4" />}
              <span className="text-sm font-medium">
                {loading ? "Checking Bot Status..." : 
                 status?.status === "connected" ? `Bot Active: @${status.bot?.username}` : 
                 "Bot Offline / Connection Error"}
              </span>
              {!loading && (
                <button onClick={fetchStatus} className="ml-2 hover:opacity-70">
                  <RefreshCcw className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Debug Info (Only if error) */}
          {!loading && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`mt-4 p-4 rounded-2xl text-xs max-w-sm mx-auto border ${
                status?.status === "connected" ? "bg-emerald-500/5 border-emerald-500/10 text-emerald-400" : "bg-red-500/5 border-red-500/10 text-red-400"
              }`}
            >
              <p className="font-semibold mb-2 uppercase tracking-wider flex items-center justify-between">
                System Status:
                {status?.status === "connected" && <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded text-emerald-500">ONLINE</span>}
              </p>
              <ul className="space-y-1 text-left list-disc list-inside opacity-80">
                <li>Bot Token: {status?.env?.hasToken ? "✅ Configured" : "❌ Missing"}</li>
                <li>Admin ID: {status?.env?.hasAdminId ? "✅ Configured" : "❌ Missing"}</li>
                {status?.status !== "connected" && <li>Error: {status?.message || "Connection failed"}</li>}
                {status?.status === "connected" && <li>Bot Name: {status.bot?.first_name}</li>}
              </ul>
              
              {status?.status === "connected" && (
                <button 
                  onClick={async () => {
                    const res = await fetch("/api/test-bot");
                    const data = await res.json();
                    alert(data.success ? "Test message sent to admin!" : `Failed: ${data.error}`);
                  }}
                  className="mt-3 w-full py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-xl transition-colors flex items-center justify-center gap-2 text-emerald-500 font-medium"
                >
                  <ShieldCheck className="w-3 h-3" />
                  Send Test Message to Admin
                </button>
              )}

              {status?.status !== "connected" && (
                <p className="mt-3 text-[10px] opacity-70 italic">
                  Pastikan Anda telah memasukkan token yang benar di panel Secrets dan merestart server.
                </p>
              )}
            </motion.div>
          )}
        </motion.div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 gap-6 mt-20">
          <FeatureCard 
            icon={<Wallet className="w-6 h-6 text-emerald-500" />}
            title="Multi-Method IDR"
            description="Mendukung OVO, DANA, GoPay, BCA, BRI, dan Mandiri untuk kemudahan transaksi."
          />
          <FeatureCard 
            icon={<ShieldCheck className="w-6 h-6 text-emerald-500" />}
            title="Verifikasi Manual"
            description="Setiap transaksi topup dan withdraw diverifikasi manual oleh admin untuk keamanan maksimal."
          />
          <FeatureCard 
            icon={<ArrowUpCircle className="w-6 h-6 text-emerald-500" />}
            title="Topup Instan"
            description="Kirim bukti transfer dan saldo akan ditambahkan segera setelah admin menyetujui."
          />
          <FeatureCard 
            icon={<ArrowDownCircle className="w-6 h-6 text-emerald-500" />}
            title="Withdraw Aman"
            description="Penarikan saldo langsung ke rekening atau e-wallet pilihan Anda."
          />
        </div>

        {/* Setup Instructions */}
        <motion.div 
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="mt-24 p-8 bg-zinc-900/50 border border-zinc-800 rounded-3xl"
        >
          <h2 className="text-2xl font-semibold mb-6">Cara Setup Bot</h2>
          <div className="space-y-4 text-zinc-400">
            <p className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-100">1</span>
              Dapatkan token bot dari <a href="https://t.me/BotFather" target="_blank" className="text-emerald-500 hover:underline">@BotFather</a>.
            </p>
            <p className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-100">2</span>
              Dapatkan Chat ID Anda (Gunakan <a href="https://t.me/userinfobot" target="_blank" className="text-emerald-500 hover:underline">@userinfobot</a>).
            </p>
            <p className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-100">3</span>
              Masukkan <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-200">TELEGRAM_BOT_TOKEN</code> dan <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-200">ADMIN_CHAT_ID</code> di Secrets panel.
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <motion.div 
      whileHover={{ y: -5 }}
      className="p-8 bg-zinc-900/50 border border-zinc-800 rounded-3xl hover:border-emerald-500/30 transition-colors"
    >
      <div className="mb-4">{icon}</div>
      <h3 className="text-xl font-semibold mb-2 text-white">{title}</h3>
      <p className="text-zinc-400 leading-relaxed">{description}</p>
    </motion.div>
  );
}
