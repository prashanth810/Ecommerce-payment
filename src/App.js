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
        note: "This is the PAYMENT / ORDER service. Address APIs are on the separate address service (/api/auth/v4/address/*).",
    });
})

// payment routes
app.use(API_BASE, Paymentroute);
app.use(API_BASE, Orderroute);


app.use("/health", healthRouter); // HEALTH (before all other routes)

// unknown route -> JSON instead of the default HTML "Cannot GET ..." page
app.use((req, res) => {
    const isAddress = req.originalUrl.startsWith("/api/auth/v4");
    return res.status(404).json({
        success: false,
        message: `Cannot ${req.method} ${req.originalUrl}`,
        hint: isAddress
            ? "Address APIs are NOT on the payment service. Call the address service URL instead."
            : `Payment and order APIs live under ${API_BASE}/...`,
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