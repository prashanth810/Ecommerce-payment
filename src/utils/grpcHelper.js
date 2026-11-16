import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import path from "path";
import { fileURLToPath } from "url";
import Envs from "./Envs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadProto = (file) =>
    grpc.loadPackageDefinition(
        protoLoader.loadSync(path.join(__dirname, "../grpc", file), {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        })
    );

let cartClient;
const getCartClient = () => {
    if (!cartClient) {
        const proto = loadProto("cart.proto");
        cartClient = new proto.cart.CartService(
            Envs.CART_GRPC_URL,
            grpc.credentials.createInsecure()
        );
    }
    return cartClient;
};

let productClient;
const getProductClient = () => {
    if (!productClient) {
        const proto = loadProto("product.proto");
        productClient = new proto.product.ProductService(
            Envs.PRODUCT_GRPC_URL,
            grpc.credentials.createInsecure()
        );
    }
    return productClient;
};

let riderClient;
const getRiderClient = () => {
    if (!riderClient) {
        const proto = loadProto("rider.proto");
        riderClient = new proto.rider.RiderService(
            Envs.RIDER_GRPC_URL,
            grpc.credentials.createInsecure()
        );
    }
    return riderClient;
};

// one place that adds the shared key + a 5 second timeout to every call
const callGrpc = (client, method, payload) =>
    new Promise((resolve, reject) => {
        const metadata = new grpc.Metadata();
        metadata.set("x-internal-key", Envs.INTERNAL_GRPC_KEY || "");

        client[method](payload, metadata, { deadline: Date.now() + 5000 }, (error, response) => {
            if (error) return reject(error);
            resolve(response);
        });
    });

// Address lookup uses the authenticated HTTP API so order placement does not
// depend on the address service's separately configured gRPC endpoint.
const getaddress = async (userId, addressId, authorization) => {
    let response;
    try {
        response = await fetch(
            `${Envs.ADDRESS_API_URL}/api/auth/v4/address/${encodeURIComponent(addressId)}`,
            {
                headers: { authorization },
                signal: AbortSignal.timeout(20000),
            }
        );
    } catch (error) {
        console.error("Paymentservice address API request failed:", error.message);
        const serviceError = new Error("Address service is not reachable");
        serviceError.code = "ADDRESS_SERVICE_UNAVAILABLE";
        throw serviceError;
    }

    if (!response.ok) {
        const serviceError = new Error(`Address service returned HTTP ${response.status}`);
        serviceError.code = "ADDRESS_SERVICE_UNAVAILABLE";
        throw serviceError;
    }

    const result = await response.json();
    const address = Array.isArray(result?.data)
        ? result.data.find((item) => String(item._id || item.id) === String(addressId))
        : result?.data;

    if (!result?.success || !address) {
        return null;
    }

    if (address.userId && String(address.userId) !== String(userId)) {
        return null;
    }

    return {
        ...address,
        id: String(address._id || address.id || addressId),
    };
};

// cart items of this user: [{ productId, weight, quantity, name, image }]
const getcartitems = async (userId) => {
    try {
        const client = getCartClient();
        const response = await callGrpc(client, "GetCartItems", { userId: String(userId) });
        return response?.items || [];
    } catch (err) {
        console.error("Paymentservice gRPC GetCartItems error:", err.message);
        return [];
    }
};

// clear cart items for user
const clearcart = async (userId) => {
    try {
        const client = getCartClient();
        const response = await callGrpc(client, "ClearCart", { userId: String(userId) });
        return response?.success || false;
    } catch (err) {
        console.error("Paymentservice gRPC ClearCart error:", err.message);
        return false;
    }
};

// product details via gRPC
const getsingleproduct = async (productId) => {
    try {
        const client = getProductClient();
        const response = await callGrpc(client, "GetProductById", { productId: String(productId) });
        return response?.success ? response.data : null;
    } catch (error) {
        console.error("Paymentservice gRPC GetProductById error:", error.message);
        return null;
    }
};

// Reduce stock for a single item after a confirmed order.
// Returns true on success, false on failure (non-fatal — order is already saved).
const reducestock = async (productId, weight, quantity) => {
    try {
        const client = getProductClient();
        const response = await callGrpc(client, "ReduceStock", {
            productId: String(productId),
            weight: String(weight),
            quantity: Number(quantity),
        });
        if (!response?.success) {
            console.warn(`ReduceStock warning [${productId} / ${weight}]:`, response?.message);
        }
        return response?.success || false;
    } catch (error) {
        console.error("Paymentservice gRPC ReduceStock error:", error.message);
        return false;
    }
};

// Restore stock for a single item when an order is cancelled or COD fails.
const restorestock = async (productId, weight, quantity) => {
    try {
        const client = getProductClient();
        const response = await callGrpc(client, "RestoreStock", {
            productId: String(productId),
            weight: String(weight),
            quantity: Number(quantity),
        });
        if (!response?.success) {
            console.warn(`RestoreStock warning [${productId} / ${weight}]:`, response?.message);
        }
        return response?.success || false;
    } catch (error) {
        console.error("Paymentservice gRPC RestoreStock error:", error.message);
        return false;
    }
};

// Send a confirmed order to the rider service. Safe to repeat: the rider service keeps ONE job per orderId.
// Returns { success, message, deliveryId } or null when the rider service cannot be reached.
const createdelivery = async (payload) => {
    try {
        return await callGrpc(getRiderClient(), "CreateDelivery", payload);
    } catch (error) {
        console.error("Paymentservice gRPC CreateDelivery error:", error.message);
        return null;
    }
};

// Cancel the delivery of an order. { success:true } when cancelled / nothing to cancel,
// { success:false } when the rider already picked it up, null when the rider service cannot be reached.
const canceldelivery = async (orderId, reason) => {
    try {
        return await callGrpc(getRiderClient(), "CancelDelivery", { orderId: String(orderId), reason: reason || "" });
    } catch (error) {
        console.error("Paymentservice gRPC CancelDelivery error:", error.message);
        return null;
    }
};

export { createdelivery, canceldelivery, getaddress, getcartitems, clearcart, getsingleproduct, reducestock, restorestock };