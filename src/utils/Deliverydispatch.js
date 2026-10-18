import OrderModel from "../models/OrderModel.js";
import PaymentModel from "../models/PaymentModel.js";
import Envs from "./Envs.js";
import { createdelivery, canceldelivery } from "./grpcHelper.js";

// Sends a CONFIRMED order to the rider service.
// Everything is read from the saved order + payment (nothing comes from the client).
// Never throws. Safe to call many times: the rider service keeps one job per order.
//
// Returns: "CREATED" | "ALREADY_SENT" | "SKIPPED" (not eligible) | "PENDING" (rider service down, will be retried)
const dispatchDelivery = async (orderId) => {
    try {
        const order = await OrderModel.findById(orderId).lean();
        if (!order) return "SKIPPED";

        // only a confirmed order is sent: PLACED (COD placed, or online paid)
        if (order.orderStatus !== "PLACED") return "SKIPPED";
        if (order.deliveryJobId) return "ALREADY_SENT";

        const payment = await PaymentModel.findOne({ orderId: order._id }).lean();
        if (!payment) return "SKIPPED";

        if (order.paymentMethod === "ONLINE") {
            // never send an unpaid online order to riders
            if (payment.paymentMethod !== "ONLINE" || payment.paymentStatus !== "SUCCESS" || !payment.isPaid) return "SKIPPED";
        } else if (payment.paymentMethod !== "COD" || ["FAILED", "CANCELLED", "REFUND"].includes(payment.paymentStatus)) {
            return "SKIPPED";
        }

        const a = order.address || {};

        const result = await createdelivery({
            orderId: String(order._id),
            customerId: String(order.userId),
            customerName: a.full_name || "",
            customerPhone: a.phone || "",
            address: {
                full_name: a.full_name || "", phone: a.phone || "", building_number: a.building_number || "",
                street: a.street || "", landmark: a.landmark || "", city: a.city || "", state: a.state || "",
                pincode: a.pincode || "", country: a.country || "", address_type: a.address_type || "",
            },
            pickupAddress: Envs.PICKUP_ADDRESS,
            items: order.items.map((i) => ({
                name: i.name || "", weight: i.weight || "", quantity: i.quantity, image: i.image || "",
            })),
            paymentMethod: order.paymentMethod,
            totalAmount: order.total, // rider service uses it as amountToCollect only for COD
        });

        if (!result) {
            // rider service down: remember it, the reconciler retries
            await OrderModel.updateOne({ _id: order._id }, { $set: { deliveryDispatchPending: true } });
            return "PENDING";
        }

        if (!result.success) {
            // rejected for a data reason, retrying will not help -> log it, do not loop forever
            console.error("CreateDelivery rejected for order", String(order._id), "-", result.message);
            await OrderModel.updateOne({ _id: order._id }, { $set: { deliveryDispatchPending: false } });
            return "SKIPPED";
        }

        await OrderModel.updateOne(
            { _id: order._id },
            { $set: { deliveryJobId: result.deliveryId, deliveryDispatchPending: false } }
        );

        // order was cancelled while we were sending it -> pull the job back
        const latest = await OrderModel.findById(order._id).select("orderStatus").lean();
        if (latest?.orderStatus === "CANCELLED") {
            await canceldelivery(order._id, "Order cancelled");
            return "SKIPPED";
        }

        return "CREATED";
    } catch (error) {
        console.error("dispatchDelivery error:", error.message);
        return "PENDING";
    }
};

// retry orders that are confirmed but not yet in the rider service
let running = false;
const reconcileDispatch = async () => {
    if (running) return;
    running = true;
    try {
        // flagged orders that got cancelled meanwhile need no retry
        await OrderModel.updateMany(
            { deliveryDispatchPending: true, orderStatus: { $ne: "PLACED" } },
            { $set: { deliveryDispatchPending: false } }
        );

        const pending = await OrderModel.find({ deliveryDispatchPending: true, orderStatus: "PLACED" }).select("_id").limit(50).lean();
        for (const o of pending) await dispatchDelivery(o._id);
    } catch (error) {
        console.error("Dispatch reconcile error:", error.message);
    } finally {
        running = false;
    }
};

const startDispatchReconciler = () => {
    const timer = setInterval(reconcileDispatch, Envs.DISPATCH_RECONCILE_MS);
    timer.unref();
};

export { dispatchDelivery, reconcileDispatch, startDispatchReconciler };