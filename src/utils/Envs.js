import dotenv from "dotenv";

dotenv.config();

const env = process.env;

const Envs = {
    PORT: env.PORT,
    MONGO_URL: env.MONGO_URL,
    JWT_SECRET: env.JWT_SECRET,
    RAZORPAY_KEY: env.RAZORPAY_KEY,
    RAZORPAY_SECRET_KEY: env.RAZORPAY_SECRET_KEY,
    RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
    ADDRESS_GRPC_URL: env.ADDRESS_GRPC_URL || "127.0.0.1:3003",
    CART_GRPC_URL: env.CART_GRPC_URL || "127.0.0.1:3002",
    PRODUCT_GRPC_URL: env.PRODUCT_GRPC_URL || "127.0.0.1:3001",
    PRODUCT_API_URL: env.PRODUCT_API_URL || "http://localhost:2001/api/auth/v2",
    INTERNAL_GRPC_KEY: env.INTERNAL_GRPC_KEY || "ecommerce_grpc_internal_secret_key_2026",
};

export default Envs;