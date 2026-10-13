import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
    productId: {
        type: String,
        required: true,
    },
    name: {
        type: String,
    },
    weight: {
        type: String,
    },
    quantity: {
        type: Number,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        default: "PENDING",
    },
    image: {
        type: String,
    },
}, { _id: false });



const OrderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true
        },
        items: [orderItemSchema],
        address: {
            type: Object, required: true
        }, // snapshot, so later address edits don't change old orders
        deliveryId: {
            type: String, enum: ["free", "standard", "express"], required: true
        },
        subtotal: {
            type: Number,
            required: true
        },
        deliveryCharge: {
            type: Number,
            required: true
        },
        tax: {
            type: Number,
            required: true
        },
        total: {
            type: Number, required: true
        },
        paymentMethod: {
            type: String, enum: ["COD", "ONLINE"], required: true
        },
        razorpay_order_id: {
            type: String
        },
        orderStatus: {
            type: String,
            enum: ["PENDING_PAYMENT", "PLACED", "CANCELLED"],
            default: "PENDING_PAYMENT",
        },
    }, { timestamps: true, minimize: false });


const OrderModel = mongoose.model("Order", OrderSchema);

export default OrderModel;