import express from "express";
import mongoose from "mongoose";
import Authmiddleware from "../middlewares/Authmiddleware.js";
import Ratelimit from "../middlewares/Ratelimit.js";
import {
    Createpayment,
    Verifypayment,
    Failpayment,
    Makecodpaid,
    Makecodfailed,
    Getpayment,
} from "../controllers/Paymentcontrollers.js";

const Paymentroute = express.Router();

// reject an invalid :orderId on every route below
Paymentroute.param("orderId", (req, res, next, value) => {
    if (!mongoose.isValidObjectId(value)) {
        return res.status(400).json({ success: false, message: "Invalid order id !!!" });
    }
    next();
});

// create payment
Paymentroute.post("/payment/create-payment", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Createpayment);

// verify razorpay payment
Paymentroute.post("/payment/verify", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Verifypayment);

// online payment failed / popup closed
Paymentroute.patch("/payment/failed/:orderId", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Failpayment);

// get my payment for an order
Paymentroute.get("/payment/:orderId", Ratelimit(60 * 1000, 20, 5 * 60 * 1000), Authmiddleware, Getpayment);

// COD paid / failed (staff only, role is checked in the controller)
Paymentroute.patch("/cod/:orderId", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Makecodpaid);
Paymentroute.patch("/cod/:orderId/failed", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Makecodfailed);

export default Paymentroute;