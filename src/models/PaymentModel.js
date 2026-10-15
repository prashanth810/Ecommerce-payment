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
        // CANCELLED = COD order cancelled (nothing was paid), REFUND = paid online order refunded
        enum: ["PENDING", "SUCCESS", "FAILED", "REFUND", "CANCELLED"],
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

    // ---- refund (filled when a paid online order is cancelled) ----
    refund_id: {
        type: String,
    },
    refund_status: {
        type: String,
        enum: ["INITIATED", "FAILED"],
    },
    refundedAt: {
        type: Date,
    },
}, { timestamps: true, minimize: false });

const PaymentModel = mongoose.model("Payment", paymentSchema);

export default PaymentModel;