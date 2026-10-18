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
        enum: ["PENDING", "CANCELLED", "DELIVERED"],
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
            // cancel is allowed only up to PACKED (see CANCELLABLE_STATUSES in the controller)
            enum: [
                "PENDING_PAYMENT",
                "PLACED",
                "CONFIRMED",
                "PROCESSING",
                "PACKED",
                "SHIPPED",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
                "CANCELLED",
            ],
            default: "PENDING_PAYMENT",
        },
        estimatedDeliveryFrom: {
            type: Date,   // earliest possible delivery date
            default: null,
        },
        estimatedDeliveryTo: {
            type: Date,   // latest possible delivery date
            default: null,
        },

        // ---- rider service integration ----
        deliveryJobId: {
            type: String,   // id of the delivery job in the rider service (set only after it was created)
        },
        deliveryDispatchPending: {
            type: Boolean,  // true = order is confirmed but the rider service was not reachable; retried automatically
            default: false,
        },
        deliveredAt: {
            type: Date,
        },

        // ---- cancel (no defaults on purpose: a user-cancelled order is the only one that has cancelledAt) ----
        cancelledAt: {
            type: Date,
        },
        cancelledBy: {
            type: String,
            enum: ["USER", "ADMIN"],
        },
        cancelReason: {
            type: String,
            trim: true,
            maxlength: 300,
        },
    }, { timestamps: true, minimize: false });


const OrderModel = mongoose.model("Order", OrderSchema);

export default OrderModel;