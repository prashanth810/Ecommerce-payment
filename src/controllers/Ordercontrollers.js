import mongoose from "mongoose";
import Razorpay from "razorpay";
import OrderModel from "../models/OrderModel.js";
import PaymentModel from "../models/PaymentModel.js";
import Envs from "../utils/Envs.js";
import { getaddress, getcartitems, getsingleproduct, clearcart } from "../utils/grpcHelper.js";


// keep these the same as the frontend config
const TAX_RATE = 0.05;
const DELIVERY = { free: 0, standard: 40, express: 99 };

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
// ---------- my orders ----------
const Getmyorders = async (req, res) => {
    const userId = req?.user?.id;

    try {
        if (!userId) {
            return res.status(401).json({ success: false, message: "User not authorized !!!" });
        }

        const orders = await OrderModel.find({ userId }).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, data: orders });
    }
    catch (error) {
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

        const order = await OrderModel.findOne({ _id: orderId, userId });
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found !!!" });
        }

        return res.status(200).json({ success: true, data: order });
    }
    catch (error) {
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

export { Placeorder, Getmyorders, Getsingleorder };