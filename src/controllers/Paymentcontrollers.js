import crypto from "crypto";
import mongoose from "mongoose";
import PaymentModel from "../models/PaymentModel.js";
import OrderModel from "../models/OrderModel.js";
import Envs from "../utils/Envs.js";
import { clearcart, reducestock, restorestock } from "../utils/grpcHelper.js";

// ---------- helpers ----------
const isText = (value) => typeof value === "string" && value.trim().length > 0;

const isId = (value) => typeof value === "string" && mongoose.isValidObjectId(value);

const safeEqual = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const serverError = (res) =>
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });

// COD status changes are only for staff (change the role names to match your auth)
const COD_ROLES = ["admin", "delivery"];

// ---------- create payment ----------
// the client only sends orderId; amount, method and razorpay order come from the saved order
const Createpayment = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.body || {};

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }
        if (!isId(orderId)) {
            return res.status(400).json({ success: false, message: "Valid Order Id required !!!" });
        }

        const order = await OrderModel.findOne({ _id: orderId, userId });

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found !!!" });
        }
        if (order.orderStatus === "CANCELLED") {
            return res.status(400).json({ success: false, message: "This order was cancelled !!!" });
        }

        const existing = await PaymentModel.findOne({ orderId });
        if (existing) {
            return res.status(409).json({
                success: false,
                message:
                    existing.paymentStatus === "SUCCESS"
                        ? "This order has already been paid !!!"
                        : "A payment already exists for this order !!!",
            });
        }

        // status is always decided by the server, never by the client
        const payment = await PaymentModel.create({
            userId,
            orderId,
            ammount: order.total,
            paymentMethod: order.paymentMethod,
            paymentStatus: "PENDING",
            isPaid: false,
            is_refund: false,
            razorpay_order_id: order.paymentMethod === "ONLINE" ? order.razorpay_order_id : undefined,
        });

        return res.status(201).json({
            success: true,
            message: "Payment created successfully !!!",
            data: payment,
        });
    }
    catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ success: false, message: "A payment already exists for this order !!!" });
        }
        return serverError(res);
    }
};

// ---------- verify online payment ----------
const Verifypayment = async (req, res) => {
    const userId = req?.user?.id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body || {};

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }
        if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(isText) || !isId(orderId)) {
            return res.status(400).json({ success: false, message: "Invalid payment details !!!" });
        }

        const payment = await PaymentModel.findOne({ orderId, userId });

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found !!!" });
        }
        if (payment.paymentMethod !== "ONLINE") {
            return res.status(400).json({ success: false, message: "This order is not an online payment !!!" });
        }
        if (payment.paymentStatus === "REFUND") {
            return res.status(400).json({ success: false, message: "This payment was refunded !!!" });
        }

        // already verified, safe to call twice
        if (payment.paymentStatus === "SUCCESS") {
            return res.status(200).json({ success: true, message: "Payment already verified !!!", data: payment });
        }

        // the razorpay order must be the one we stored for this order
        if (payment.razorpay_order_id !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: "Payment details do not match this order !!!" });
        }

        const expectedSignature = crypto
            .createHmac("sha256", Envs.RAZORPAY_SECRET_KEY)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");

        if (!safeEqual(expectedSignature, razorpay_signature)) {
            payment.paymentStatus = "FAILED";
            payment.isPaid = false;
            payment.failureReason = "Signature verification failed";
            payment.failedAt = new Date();
            await payment.save();

            return res.status(400).json({ success: false, message: "Payment verification failed !!!" });
        }

        // the same razorpay payment must not be used for another order
        const reused = await PaymentModel.findOne({ razorpay_payment_id, _id: { $ne: payment._id } });
        if (reused) {
            return res.status(409).json({ success: false, message: "This payment is already used !!!" });
        }

        payment.razorpay_payment_id = razorpay_payment_id;
        payment.razorpay_signature = razorpay_signature;
        payment.paymentStatus = "SUCCESS";
        payment.isPaid = true;
        payment.paymentDate = new Date();
        payment.failureReason = undefined;
        payment.failedAt = undefined;
        await payment.save();

        // payment done -> confirm the order
        const confirmedOrder = await OrderModel.findByIdAndUpdate(
            payment.orderId,
            { orderStatus: "PLACED" },
            { new: true }
        );
        await clearcart(userId);

        // Reduce stock for every item in the order (fire-and-forget, non-fatal)
        if (confirmedOrder?.items?.length) {
            await Promise.allSettled(
                confirmedOrder.items.map((item) =>
                    reducestock(item.productId, item.weight, item.quantity)
                )
            );
        }

        return res.status(200).json({
            success: true,
            message: "Payment verified successfully !!!",
            data: payment,
        });
    }
    catch (error) {
        return serverError(res);
    }
};

// ---------- online payment failed / popup closed (called by frontend) ----------
const Failpayment = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.params;
    const reason = isText(req.body?.reason)
        ? req.body.reason.trim().slice(0, 200)
        : "Payment failed or cancelled";

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }

        // atomic: only a PENDING online payment of this user can become FAILED
        // (a SUCCESS payment can never be overwritten)
        const payment = await PaymentModel.findOneAndUpdate(
            { orderId, userId, paymentMethod: "ONLINE", paymentStatus: "PENDING" },
            { paymentStatus: "FAILED", isPaid: false, failureReason: reason, failedAt: new Date() },
            { new: true }
        );

        if (!payment) {
            return res.status(404).json({ success: false, message: "No pending online payment found for this order !!!" });
        }

        // unpaid order is cancelled (the user can place a new one)
        await OrderModel.findOneAndUpdate(
            { _id: payment.orderId, orderStatus: "PENDING_PAYMENT" },
            { orderStatus: "CANCELLED" }
        );

        return res.status(200).json({ success: true, message: "Payment marked as failed !!!", data: payment });
    }
    catch (error) {
        return serverError(res);
    }
};

// ---------- COD: mark as paid (staff only) ----------
const Makecodpaid = async (req, res) => {
    const { orderId } = req.params;

    try {
        if (!COD_ROLES.includes(req?.user?.role)) {
            return res.status(403).json({ success: false, message: "Not allowed !!!" });
        }

        const payment = await PaymentModel.findOneAndUpdate(
            { orderId, paymentMethod: "COD", paymentStatus: "PENDING" },
            { paymentStatus: "SUCCESS", isPaid: true, paymentDate: new Date() },
            { new: true }
        );

        if (!payment) {
            return res.status(404).json({ success: false, message: "No pending COD payment found for this order !!!" });
        }

        return res.status(200).json({ success: true, message: "COD marked as paid !!!", data: payment });
    }
    catch (error) {
        return serverError(res);
    }
};

// ---------- COD: failed (customer refused / not delivered) (staff only) ----------
const Makecodfailed = async (req, res) => {
    const { orderId } = req.params;
    const reason = isText(req.body?.reason) ? req.body.reason.trim().slice(0, 200) : "COD payment failed";

    try {
        if (!COD_ROLES.includes(req?.user?.role)) {
            return res.status(403).json({ success: false, message: "Not allowed !!!" });
        }

        const payment = await PaymentModel.findOneAndUpdate(
            { orderId, paymentMethod: "COD", paymentStatus: "PENDING" },
            { paymentStatus: "FAILED", isPaid: false, failureReason: reason, failedAt: new Date() },
            { new: true }
        );

        if (!payment) {
            return res.status(404).json({ success: false, message: "No pending COD payment found for this order !!!" });
        }

        const cancelledOrder = await OrderModel.findByIdAndUpdate(
            payment.orderId,
            { orderStatus: "CANCELLED" },
            { new: true }
        );

        // Restore stock for every item since COD order was already confirmed (stock was reduced at placement)
        if (cancelledOrder?.items?.length) {
            await Promise.allSettled(
                cancelledOrder.items.map((item) =>
                    restorestock(item.productId, item.weight, item.quantity)
                )
            );
        }

        return res.status(200).json({ success: true, message: "COD marked as failed !!!", data: payment });
    }
    catch (error) {
        return serverError(res);
    }
};

// ---------- get my payment for an order ----------
const Getpayment = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.params;

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }

        const payment = await PaymentModel.findOne({ orderId, userId }).select("-razorpay_signature");

        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found !!!" });
        }

        return res.status(200).json({ success: true, data: payment });
    }
    catch (error) {
        return serverError(res);
    }
};

export { Createpayment, Verifypayment, Failpayment, Makecodpaid, Makecodfailed, Getpayment };