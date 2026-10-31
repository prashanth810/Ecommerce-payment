import express from "express";
import mongoose from "mongoose";

const healthRouter = express.Router();

const withTimeout = (promise, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Really talks to MongoDB (not just "server is up"), so the DB stays awake too
const checkDb = async () => {
    if (mongoose.connection.readyState !== 1) throw new Error("not connected");
    await mongoose.connection.db.admin().ping();
};

// GET /health
healthRouter.get("/", async (req, res) => {
    let db = "connected";

    try {
        await withTimeout(checkDb(), 5000);
    } catch {
        db = "disconnected";
    }

    const ok = db === "connected";

    res.setHeader("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({
        success: ok,
        status: ok ? "ok" : "degraded",
        service: process.env.SERVICE_NAME || "auth-service",
        db,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

export default healthRouter;