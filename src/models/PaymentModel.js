import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        unique: true,
        required: true,
    },
    ammount: {
        type: Number,
        required: true,
    },
    currency: {
        type: String,
        default: "INR",
    },
    paymentMethod: {
        type: String,
        enum: ["ONLINE", "COD"],
        required: true,
    },
    paymentStatus: {
        type: String,
        enum: ["PENDING", "SUCCESS", "FAILED", "REFUND"],
        required: true,
    },
    razorpay_order_id: {
        type: String,
    },
    razorpay_payment_id: {
        type: String,
    },
    razorpay_signature: {
        type: String,
    },
    paymentDate: {
        type: Date,
        default: Date.now,
    },
    failureReason: {
        type: String,
    },
    failedAt: {
        type: Date,
    },
    isPaid: {
        type: Boolean,
        default: false,
    },
    is_refund: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true, minimize: false });

const PaymentModel = mongoose.model("Payment", paymentSchema);

export default PaymentModel;