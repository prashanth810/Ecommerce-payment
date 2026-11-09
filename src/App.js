import express, { application } from "express";
import cors from "cors";
import morgan from "morgan";
import Envs from "./utils/Envs.js";
import ConnectionDb from "./config/ConnectDb.js";
import Paymentroute from "./routes/Paymentroutes.js";
import Orderroute from "./routes/Orderroute.js";
import startOrderGrpcServer from "./grpc/Ordergrpcserver.js";
import { startDispatchReconciler } from "./utils/Deliverydispatch.js";
import healthRouter from "./health/health.routes.js";




const app = express();
const PORT = Envs.PORT || 5000;
const API_BASE = "/api/auth/v5";

// Render puts a proxy in front of the app. Without this, req.ip is the proxy IP,
// so every user shares ONE rate-limit bucket.
app.set("trust proxy", 1);

app.use(cors());
app.use(morgan('dev'));

app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }));


app.get("/", (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Server from paymentbackend !!!",
        service: process.env.SERVICE_NAME || "payment-service",
        base: API_BASE,
        note: "PAYMENT / ORDER service. /api/auth/v4/* is forwarded to the address service.",
    });
})

// payment routes
app.use(API_BASE, Paymentroute);
app.use(API_BASE, Orderroute);


app.use("/health", healthRouter); // HEALTH (before all other routes)

// ─── Address API forwarding ──────────────────────────────────────────────────
// The address APIs live on the separate ADDRESS service. If the frontend still calls
// this (payment) URL for /api/auth/v4/..., forward the request to the address service.
// Set ADDRESS_API_URL on Render, e.g. https://ecommerce-address-xxxx.onrender.com
const ADDRESS_API_URL = (process.env.ADDRESS_API_URL || "").trim().replace(/\/+$/, "");

app.use("/api/auth/v4", async (req, res) => {
    if (!ADDRESS_API_URL) {
        return res.status(503).json({
            success: false,
            message: "Address service is not configured. Set ADDRESS_API_URL on the payment service.",
        });
    }

    try {
        const hasBody = !["GET", "HEAD"].includes(req.method);
        const headers = {
            "x-forwarded-for": [req.headers["x-forwarded-for"], req.ip].filter(Boolean).join(", "),
        };
        if (req.headers.authorization) headers.authorization = req.headers.authorization;
        if (hasBody) headers["content-type"] = "application/json";

        const response = await fetch(`${ADDRESS_API_URL}${req.originalUrl}`, {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
            signal: AbortSignal.timeout(20000), // Render free tier can take a while to wake up
        });

        res.status(response.status);
        res.set("Content-Type", response.headers.get("content-type") || "application/json");
        return res.send(await response.text());
    } catch (error) {
        console.error("Address forward failed:", error.message);
        return res.status(502).json({ success: false, message: "Address service is not reachable: " + error.message });
    }
});

// unknown route -> JSON instead of the default HTML "Cannot GET ..." page
app.use((req, res) => {
    return res.status(404).json({
        success: false,
        message: `Cannot ${req.method} ${req.originalUrl}`,
        hint: `Payment and order APIs live under ${API_BASE}/...`,
    });
});

// any error thrown inside a route / middleware
app.use((error, req, res, next) => {
    console.error("Unhandled error:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message });
});

// db connecion 
ConnectionDb().then(() => {
    app.listen(PORT, () => {
        console.log(`server started at http://localhost:${PORT}`);
    });
    startOrderGrpcServer();      // rider service reports pickup / delivered here
    startDispatchReconciler();   // retries orders that could not be sent to riders
})
    .catch((error) => {
        console.error(error.message)
    })