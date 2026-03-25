"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const uuid_1 = require("uuid");
const axios_1 = __importDefault(require("axios"));
const app = (0, express_1.default)();
// ─── Database Setup ───────────────────────────────────────────────────────────
const DATA_DIR = path_1.default.join(process.cwd(), "data");
if (!fs_1.default.existsSync(DATA_DIR)) {
    fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path_1.default.join(DATA_DIR, "ltc-fast-track.db");
const db = new better_sqlite3_1.default(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phoneNumber TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL UNIQUE,
    balance REAL NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    depositId TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_userId ON transactions(userId);
  CREATE INDEX IF NOT EXISTS idx_transactions_depositId ON transactions(depositId);
  CREATE INDEX IF NOT EXISTS idx_wallets_userId ON wallets(userId);
`);
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express_1.default.json());
app.use(express_1.default.raw({ type: "*/*", limit: "10mb" }));
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Content-Digest");
    res.header("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
    }
    next();
});
// ─── Database Helpers ─────────────────────────────────────────────────────────
function getOrCreateUser(phoneNumber) {
    const existing = db.prepare("SELECT * FROM users WHERE phoneNumber = ?").get(phoneNumber);
    if (existing)
        return existing;
    const userId = `user_${(0, uuid_1.v4)().substring(0, 8)}`;
    db.prepare("INSERT INTO users (id, phoneNumber) VALUES (?, ?)").run(userId, phoneNumber);
    return { id: userId, phoneNumber, createdAt: new Date().toISOString() };
}
function getOrCreateWallet(userId) {
    const existing = db.prepare("SELECT * FROM wallets WHERE userId = ?").get(userId);
    if (existing)
        return existing;
    const walletId = `wallet_${(0, uuid_1.v4)().substring(0, 8)}`;
    db.prepare("INSERT INTO wallets (id, userId, balance) VALUES (?, ?, ?)").run(walletId, userId, 0);
    return { id: walletId, userId, balance: 0, updatedAt: new Date().toISOString() };
}
function createTransaction(userId, depositId, amount) {
    const txnId = `txn_${(0, uuid_1.v4)().substring(0, 8)}`;
    db.prepare("INSERT INTO transactions (id, userId, depositId, amount, status) VALUES (?, ?, ?, ?, ?)").run(txnId, userId, depositId, amount, "pending");
    return { id: txnId, userId, depositId, amount, status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function getTransactionByDepositId(depositId) {
    return db.prepare("SELECT * FROM transactions WHERE depositId = ?").get(depositId);
}
function updateTransactionStatus(depositId, status) {
    db.prepare("UPDATE transactions SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE depositId = ?").run(status, depositId);
    return db.prepare("SELECT * FROM transactions WHERE depositId = ?").get(depositId);
}
function getWalletByUserId(userId) {
    return db.prepare("SELECT * FROM wallets WHERE userId = ?").get(userId);
}
function updateWalletBalance(userId, amount) {
    db.prepare("UPDATE wallets SET balance = balance + ?, updatedAt = CURRENT_TIMESTAMP WHERE userId = ?").run(amount, userId);
    return db.prepare("SELECT * FROM wallets WHERE userId = ?").get(userId);
}
function getTransactionsByUserId(userId) {
    return db.prepare("SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC").all(userId);
}
function getUserById(userId) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}
// ─── Routes ───────────────────────────────────────────────────────────────────
// Health check
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});
// Create deposit (real API call)
app.post("/api/payments/pawapay", async (req, res) => {
    try {
        const { amount, phoneNumber } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid amount", errorCode: "INVALID_AMOUNT" });
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, message: "Missing phoneNumber", errorCode: "MISSING_PHONE" });
        }
        // Get or create user + wallet
        const user = getOrCreateUser(phoneNumber);
        getOrCreateWallet(user.id);
        const depositId = `PAWAPAY-${(0, uuid_1.v4)().substring(0, 12).toUpperCase()}`;
        // 🔐 Call PawaPay Sandbox API
        const BASE_URL =
        process.env.NODE_ENV === "production"
            ? "https://api.pawapay.io"
            : "https://api.sandbox.pawapay.io";
        const pawapayResponse = await axios_1.default.post(`${BASE_URL}/v1/deposits`, {
            depositId: depositId,
            amount: amount.toString(),
            currency: "ZMW",
            country: "ZMB",
            customerTimestamp: new Date().toISOString(),
            payer: {
                type: "MSISDN",
                address: {
                    value: phoneNumber,
                },
            },
            correspondent: "MTN_MOMO_ZMB",
            callbackUrl:
         "https://ltc-fast-track-backend-production.up.railway.app/api/payments/pawapay/callback",
        }, {
            headers: {
                Authorization: `Bearer ${process.env.PAWAPAY_API_KEY}`,
                "Content-Type": "application/json",
            },
        });
        // Save transaction locally (still needed)
        const transaction = createTransaction(user.id, depositId, amount);
        res.status(201).json({
            success: true,
            data: {
                depositId,
                status: pawapayResponse.data?.status || "SUBMITTED",
                amount,
                phoneNumber,
                userId: user.id,
                transactionId: transaction.id,
                pawapay: pawapayResponse.data,
                createdAt: new Date().toISOString(),
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("[PawaPay Error]", error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: error.response?.data || error.message,
            errorCode: "PAWAPAY_ERROR",
        });
    }
});
// Webhook callback
app.post("/api/payments/pawapay/callback", (req, res) => {
    try {
        const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        const { depositId, status, amount } = payload;
        if (!depositId || !status) {
            return res.status(400).json({ success: false, message: "Missing depositId or status" });
        }
        const transaction = getTransactionByDepositId(depositId);
        if (!transaction) {
            return res.status(404).json({ success: false, message: "Transaction not found" });
        }
        if (status === "COMPLETED") {
            updateTransactionStatus(depositId, "completed");
            updateWalletBalance(transaction.userId, parseFloat(amount || String(transaction.amount)));
        }
        else if (status === "FAILED") {
            updateTransactionStatus(depositId, "failed");
        }
        res.json({ success: true, data: { received: true, depositId }, timestamp: new Date().toISOString() });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : "Internal server error";
        res.status(500).json({ success: false, message: msg });
    }
});
// Get wallet balance
app.get("/api/wallet/:userId", (req, res) => {
    try {
        const { userId } = req.params;
        const user = getUserById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        const wallet = getWalletByUserId(userId);
        if (!wallet) {
            return res.status(404).json({ success: false, message: "Wallet not found" });
        }
        res.json({
            success: true,
            data: {
                walletId: wallet.id,
                userId: wallet.userId,
                balance: wallet.balance,
                phoneNumber: user.phoneNumber,
                updatedAt: wallet.updatedAt,
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : "Internal server error";
        res.status(500).json({ success: false, message: msg });
    }
});
// Get transactions
app.get("/api/transactions/:userId", (req, res) => {
    try {
        const { userId } = req.params;
        const user = getUserById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        const transactions = getTransactionsByUserId(userId);
        const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);
        const completedAmount = transactions
            .filter((t) => t.status === "completed")
            .reduce((sum, t) => sum + t.amount, 0);
        res.json({
            success: true,
            data: {
                userId,
                phoneNumber: user.phoneNumber,
                transactions,
                total: transactions.length,
                totalAmount,
                completedAmount,
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : "Internal server error";
        res.status(500).json({ success: false, message: msg });
    }
});
// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error("[Error]", err.message);
    if (!res.headersSent) {
        res.status(500).json({ success: false, message: err.message || "Internal server error" });
    }
});
// ─── Server Startup ───────────────────────────────────────────────────────────
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(`[Database] ${DB_PATH}`);
    console.log(`[Health] http://localhost:${PORT}/api/health`);
    console.log(`[Deposit] POST http://localhost:${PORT}/api/payments/pawapay`);
    console.log(`[Callback] POST http://localhost:${PORT}/api/payments/pawapay/callback`);
    console.log(`[Wallet] GET http://localhost:${PORT}/api/wallet/:userId`);
    console.log(`[Transactions] GET http://localhost:${PORT}/api/transactions/:userId`);
});
const shutdown = () => {
    console.log("[Server] Shutting down...");
    db.close();
    process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
