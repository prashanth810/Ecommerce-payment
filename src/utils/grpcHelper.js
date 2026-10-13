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

let addressClient;
const getAddressClient = () => {
    if (!addressClient) {
        const proto = loadProto("address.proto");
        addressClient = new proto.address.AddressService(
            Envs.ADDRESS_GRPC_URL,
            grpc.credentials.createInsecure()
        );
    }
    return addressClient;
};

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

// address of this user (null if it does not exist or belongs to someone else)
const getaddress = async (userId, addressId) => {
    try {
        const client = getAddressClient();
        const response = await callGrpc(client, "GetAddressById", {
            userId: String(userId),
            addressId: String(addressId),
        });
        return response?.success ? response.data : null;
    } catch (err) {
        console.error("Paymentservice gRPC GetAddressById error:", err.message);
        return null;
    }
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

export { getaddress, getcartitems, clearcart, getsingleproduct };