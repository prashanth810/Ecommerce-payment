import mongoose from "mongoose";
import Razorpay from "razorpay";
import OrderModel from "../models/OrderModel.js";
import PaymentModel from "../models/PaymentModel.js";
import Envs from "../utils/Envs.js";
import { getaddress, getcartitems, getsingleproduct, clearcart, reducestock, restorestock } from "../utils/grpcHelper.js";
import { createInvoicePdf, getInvoiceNumber } from "../utils/invoicePdf.js";


// keep these the same as the frontend config
const TAX_RATE = 0.05;
const DELIVERY = { free: 0, standard: 40, express: 99 };

// Delivery method → business days range
const DELIVERY_CONFIG = {
    free: { minDays: 2, maxDays: 3 },
    standard: { minDays: 1, maxDays: 2 },
    express: { minDays: 1, maxDays: 1 }, // next business day
};

// user can cancel a placed order ONLY while it is in one of these (nothing shipped yet)
const CANCELLABLE_STATUSES = ["PLACED", "CONFIRMED", "PROCESSING", "PREPARING", "PACKED"];

// Orders the user should never see:
//  - PENDING_PAYMENT (online payment not finished)
//  - CANCELLED without cancelledAt (payment popup closed / payment failed)
// A CANCELLED order that has cancelledAt was cancelled by the user after it was placed -> visible.
const VISIBLE_ORDER_FILTER = {
    $nor: [
        { orderStatus: "PENDING_PAYMENT" },
        { orderStatus: "CANCELLED", cancelledAt: { $exists: false } },
    ],
};

// Add `n` business days to a date (skips Sundays; Saturday counts as working)
const addBusinessDays = (date, days) => {
    const result = new Date(date);
    let added = 0;
    while (added < days) {
        result.setDate(result.getDate() + 1);
        if (result.getDay() !== 0) added++; // 0 = Sunday — skip
    }
    return result;
};

// Returns { from: Date, to: Date } for the chosen delivery method
// Time is set to end-of-business (18:00 IST = 12:30 UTC) so frontend
// can show "by 6 PM" if it wants.
const getEstimatedDeliveryDates = (deliveryId) => {
    const cfg = DELIVERY_CONFIG[deliveryId];
    if (!cfg) return { from: null, to: null };

    const now = new Date();
    const from = addBusinessDays(now, cfg.minDays);
    const to = addBusinessDays(now, cfg.maxDays);

    // Set time to 18:00 IST (UTC+5:30 → 12:30 UTC)
    [from, to].forEach((d) => {
        d.setUTCHours(12, 30, 0, 0);
    });

    return { from, to };
};

let razorpayClient;
const getRazorpay = () => {
    if (!razorpayClient) {
        razorpayClient = new Razorpay({ key_id: Envs.RAZORPAY_KEY, key_secret: Envs.RAZORPAY_SECRET_KEY });
    }
    return razorpayClient;
};

// ---------- place order ----------
const Placeorder = async (req, res) => {
    let userId = req?.user?.id || req?.user?._id || req?.body?.userId;
    const { addressId, deliveryId, paymentMethod, items: bodyItems } = req.body || {};

    try {
        if (typeof addressId !== "string" || !addressId.trim()) {
            return res.status(400).json({ success: false, message: "Address is required !!!" });
        }
        if (typeof deliveryId !== "string" || !Object.hasOwn(DELIVERY, deliveryId)) {
            return res.status(400).json({ success: false, message: "Invalid delivery method !!!" });
        }
        if (!["COD", "ONLINE"].includes(paymentMethod)) {
            return res.status(400).json({ success: false, message: "Invalid payment method !!!" });
        }

        // 1. address from the address service (gRPC)
        const address = await getaddress(userId || "", addressId.trim());
        if (!address) {
            return res.status(404).json({ success: false, message: "Address not found !!!" });
        }

        if (!userId && address.userId) {
            userId = address.userId;
        }

        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }

        // 2. items: either from req.body.items (Buy Now / Swagger) or from cart service (gRPC)
        let cartItems = Array.isArray(bodyItems) && bodyItems.length > 0
            ? bodyItems
            : await getcartitems(userId);

        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({ success: false, message: "Your cart is empty !!!" });
        }

        // 3. price + stock from the product service (never trusted from the cart or client)
        const productIds = [...new Set(cartItems.map((item) => String(item.productId || item.id)))];
        const products = Object.fromEntries(
            await Promise.all(productIds.map(async (id) => [id, await getsingleproduct(id)]))
        );

        const items = [];
        for (const cartItem of cartItems) {
            const pid = String(cartItem.productId || cartItem.id);
            const product = products[pid];
            const variant = product?.variants?.find((v) => v.weight === cartItem.weight);

            if (!product || !variant) {
                return res.status(400).json({
                    success: false,
                    message: `${cartItem.name || product?.name || "An item"} is no longer available !!!`,
                });
            }

            const stock = Number(variant.stock ?? variant.stock_quantity ?? product.stock);
            const qty = Number(cartItem.quantity) || 1;
            if (Number.isFinite(stock) && stock < qty) {
                return res.status(400).json({
                    success: false,
                    message: `Only ${stock} left for ${product.name} (${variant.weight}) !!!`,
                });
            }

            items.push({
                productId: pid,
                name: product.name,
                weight: variant.weight,
                price: Number(variant.selling_price),
                quantity: qty,
                image: product.thumbnail || product.images?.[0] || cartItem.image,
            });
        }

        if (items.some((i) => !Number.isFinite(i.price) || i.price < 0)) {
            return res.status(400).json({ success: false, message: "Invalid product price !!!" });
        }

        // 4. totals are calculated on the server
        const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        const deliveryCharge = DELIVERY[deliveryId];
        const tax = Number((subtotal * TAX_RATE).toFixed(2));
        const total = Number((subtotal + deliveryCharge + tax).toFixed(2));

        // save only the delivery fields (a snapshot of the address)
        const addressSnapshot = {
            addressId: address.id,
            full_name: address.full_name,
            phone: address.phone,
            building_number: address.building_number,
            street: address.street,
            landmark: address.landmark,
            city: address.city,
            state: address.state,
            pincode: address.pincode,
            country: address.country,
            address_type: address.address_type,
        };

        const { from: estimatedDeliveryFrom, to: estimatedDeliveryTo } = getEstimatedDeliveryDates(deliveryId);

        const order = await OrderModel.create({
            userId,
            items,
            address: addressSnapshot,
            deliveryId,
            subtotal,
            deliveryCharge,
            tax,
            total,
            paymentMethod,
            estimatedDeliveryFrom,
            estimatedDeliveryTo,
            orderStatus: paymentMethod === "COD" ? "PLACED" : "PENDING_PAYMENT",
        });

        if (paymentMethod === "COD") {
            await PaymentModel.create({
                userId,
                orderId: order._id,
                ammount: total,
                paymentMethod: "COD",
                paymentStatus: "PENDING",
                isPaid: false,
                is_refund: false,
            });
            await clearcart(userId);

            // Reduce stock for every ordered item (fire-and-forget, non-fatal)
            await Promise.allSettled(
                items.map((item) =>
                    reducestock(item.productId, item.weight, item.quantity)
                )
            );

            return res.status(201).json({ success: true, message: "Order placed !!!", data: { order } });
        }

        // online (UPI / card): create the razorpay order on the server
        try {
            const rzpOrder = await getRazorpay().orders.create({
                amount: Math.round(total * 100), // paise
                currency: "INR",
                receipt: String(order._id),
            });

            order.razorpay_order_id = rzpOrder.id;
            await order.save();

            await PaymentModel.create({
                userId,
                orderId: order._id,
                ammount: total,
                paymentMethod: "ONLINE",
                paymentStatus: "PENDING",
                isPaid: false,
                is_refund: false,
                razorpay_order_id: rzpOrder.id,
            });

            return res.status(201).json({
                success: true,
                message: "Order created !!!",
                data: {
                    order,
                    razorpay: {
                        id: rzpOrder.id,
                        amount: rzpOrder.amount,
                        currency: rzpOrder.currency,
                        key: Envs.RAZORPAY_KEY, // public key id, safe to send
                    },
                },
            });
        } catch (rzpError) {
            order.orderStatus = "CANCELLED";
            await order.save();
            return res.status(502).json({ success: false, message: "Unable to start the payment. Please try again." });
        }
    }
    catch (error) {
        console.error("Placeorder error:", error.message);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

// ---------- my orders (paginated) ----------
// GET /order/my-orders?page=1&limit=10
const Getmyorders = async (req, res) => {
    const userId = req?.user?.id;

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
        const skip = (page - 1) * limit;

        // hides unpaid / abandoned orders, shows orders the user cancelled
        const filter = { userId, ...VISIBLE_ORDER_FILTER };

        const [orders, totalItems] = await Promise.all([
            OrderModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            OrderModel.countDocuments(filter),
        ]);

        const totalPages = Math.ceil(totalItems / limit);

        return res.status(200).json({
            success: true,
            data: orders,
            pagination: {
                totalItems,
                totalPages,
                currentPage: page,
                limit,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
        });
    }
    catch (error) {
        console.error("Getmyorders error:", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

// ---------- single order ----------
const Getsingleorder = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.params;

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }
        if (!mongoose.isValidObjectId(orderId)) {
            return res.status(400).json({ success: false, message: "Invalid order id !!!" });
        }

        const order = await OrderModel.findOne({ _id: orderId, userId, ...VISIBLE_ORDER_FILTER }).lean();

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found !!!" });
        }

        return res.status(200).json({ success: true, data: order });
    }
    catch (error) {
        console.error("Getsingleorder error:", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

// ---------- invoice (PDF) ----------
const Getinvoice = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.params;

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }
        if (!mongoose.isValidObjectId(orderId)) {
            return res.status(400).json({ success: false, message: "Invalid order id !!!" });
        }

        // only the owner can download, so a user never sees someone else's invoice
        const order = await OrderModel.findOne({ _id: orderId, userId }).lean();
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found !!!" });
        }
        if (order.orderStatus !== "PLACED") {
            return res.status(400).json({ success: false, message: "Invoice is available only for placed orders !!!" });
        }

        const payment = await PaymentModel.findOne({ orderId: order._id }).lean();

        const doc = createInvoicePdf({ order, payment });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${getInvoiceNumber(order)}.pdf"`);

        doc.pipe(res);
        doc.end();
    }
    catch (error) {
        console.error("Getinvoice error:", error.message);
        if (res.headersSent) return res.end();
        return res.status(500).json({ success: false, message: "Unable to generate the invoice. Please try again." });
    }
};

// ---------- cancel order (ONE api for both cases) ----------
// PATCH /order/cancel/:orderId   body: { reason?: string }
//
//  A) PENDING_PAYMENT  -> online payment not finished (popup closed / payment failed)
//                         just close it: no refund, no restock, stays hidden from the user
//  B) PLACED ... PACKED -> real order, cancelled BEFORE shipping
//                         refund (if paid online) + restock + visible as "Cancelled"
//  anything shipped / delivered / already cancelled -> rejected with a clear message

const Cancelorder = async (req, res) => {
    const userId = req?.user?.id;
    const { orderId } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }
        if (!mongoose.isValidObjectId(orderId)) {
            return res.status(400).json({ success: false, message: "Invalid order id !!!" });
        }

        // ================= A) unpaid online order =================
        const unpaidOrder = await OrderModel.findOneAndUpdate(
            { _id: orderId, userId, orderStatus: "PENDING_PAYMENT" },
            { $set: { orderStatus: "CANCELLED" } }, // no cancelledAt on purpose -> stays hidden
            { new: true }
        ).lean();

        if (unpaidOrder) {
            await PaymentModel.updateOne(
                { orderId: unpaidOrder._id, paymentStatus: "PENDING" },
                { paymentStatus: "FAILED", failureReason: "Payment cancelled by user", failedAt: new Date() }
            );

            return res.status(200).json({
                success: true,
                message: "Order cancelled !!!",
                data: { _id: unpaidOrder._id, orderStatus: unpaidOrder.orderStatus, refund: { status: "NOT_REQUIRED" } },
            });
        }

        // ================= B) placed order, not shipped yet =================
        // ONE atomic update: owner + still not shipped.
        // If two requests arrive together only one of them can match, so no double cancel / double refund.
        const order = await OrderModel.findOneAndUpdate(
            { _id: orderId, userId, orderStatus: { $in: CANCELLABLE_STATUSES } },
            {
                $set: {
                    orderStatus: "CANCELLED",
                    cancelledAt: new Date(),
                    cancelledBy: "USER",
                    cancelReason: reason,
                    "items.$[].status": "CANCELLED",
                },
            },
            { new: true }
        ).lean();

        // nothing matched -> tell the user exactly why
        if (!order) {
            const existing = await OrderModel.findOne({ _id: orderId, userId }).select("orderStatus cancelledAt").lean();

            if (!existing || (existing.orderStatus === "CANCELLED" && !existing.cancelledAt)) {
                return res.status(404).json({ success: false, message: "Order not found !!!" });
            }
            if (existing.orderStatus === "CANCELLED") {
                return res.status(400).json({ success: false, message: "This order is already cancelled !!!" });
            }
            return res.status(400).json({
                success: false,
                message: "This order can't be cancelled because it has already been shipped !!!",
            });
        }

        // payment: refund if it was paid online, otherwise just close the COD payment
        let refund = { status: "NOT_REQUIRED" };
        const payment = await PaymentModel.findOne({ orderId: order._id });

        if (payment) {
            if (payment.paymentMethod === "ONLINE" && payment.isPaid) {
                try {
                    if (!payment.razorpay_payment_id) {
                        throw new Error("razorpay_payment_id is missing on the payment");
                    }

                    const rzpRefund = await getRazorpay().payments.refund(payment.razorpay_payment_id, {
                        amount: Math.round(order.total * 100), // paise
                        speed: "normal",
                        notes: { orderId: String(order._id), reason: reason || "Cancelled by user" },
                    });

                    payment.is_refund = true;
                    payment.paymentStatus = "REFUND";
                    payment.refundedAt = new Date();
                    payment.refund_id = rzpRefund.id;
                    payment.refund_status = "INITIATED";
                    refund = { status: "INITIATED", refundId: rzpRefund.id };
                } catch (refundError) {
                    // order stays cancelled; marked so you can retry the refund manually / from a cron
                    console.error("Refund failed for order", String(order._id), refundError?.error?.description || refundError.message);
                    payment.refund_status = "FAILED";
                    refund = { status: "FAILED" };
                }
            } else {
                payment.paymentStatus = "CANCELLED";
            }
            await payment.save();
        }

        // give the stock back (one failure must not break the cancel)
        const restock = await Promise.allSettled(
            order.items.map((item) => restorestock(String(item.productId), item.weight, item.quantity))
        );
        restock.forEach((r, i) => {
            if (r.status === "rejected") {
                console.error("Restock failed:", String(order._id), order.items[i].productId, r.reason?.message);
            }
        });

        const message =
            refund.status === "INITIATED"
                ? "Order cancelled. Your refund has been initiated and will reach you in 5-7 working days."
                : refund.status === "FAILED"
                    ? "Order cancelled. We couldn't start your refund automatically, our team will process it shortly."
                    : "Order cancelled !!!";

        return res.status(200).json({
            success: true,
            message,
            data: { _id: order._id, orderStatus: order.orderStatus, cancelledAt: order.cancelledAt, refund },
        });
    }
    catch (error) {
        console.error("Cancelorder error:", error.message);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

// old name kept so existing routes / imports don't break
const Cancelpendingorder = Cancelorder;

export { Placeorder, Getmyorders, Getsingleorder, Cancelorder, Cancelpendingorder, Getinvoice };