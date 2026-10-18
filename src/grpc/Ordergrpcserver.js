import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import OrderModel from "../models/OrderModel.js";
import PaymentModel from "../models/PaymentModel.js";
import Envs from "../utils/Envs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const orderProto = grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(__dirname, "./order.proto"), {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    })
).order;

const isAllowed = (call) => {
    const key = call?.metadata?.get("x-internal-key")?.[0];
    return Boolean(key && key === Envs.INTERNAL_GRPC_KEY);
};

// statuses an order can be in before it is handed to the rider
const BEFORE_OUT = ["PLACED", "CONFIRMED", "PROCESSING", "PREPARING", "PACKED", "SHIPPED"];

// The rider service calls this when a rider picks up / delivers. Repeating a call is safe.
const UpdateOrderStatus = async (call, callback) => {
    if (!isAllowed(call)) return callback({ code: grpc.status.UNAUTHENTICATED, message: "Not allowed" });

    try {
        const { orderId, status, deliveredAt } = call.request;

        if (!mongoose.isValidObjectId(orderId)) return callback(null, { success: false, message: "Invalid orderId" });
        if (!["OUT_FOR_DELIVERY", "DELIVERED"].includes(status)) return callback(null, { success: false, message: "Invalid status" });

        const order = await OrderModel.findById(orderId).select("orderStatus").lean();
        if (!order) return callback(null, { success: false, message: "Order not found" });

        // a cancelled order is never moved forward
        if (order.orderStatus === "CANCELLED") return callback(null, { success: false, message: "Order is cancelled" });

        if (status === "OUT_FOR_DELIVERY") {
            if (order.orderStatus === "OUT_FOR_DELIVERY" || order.orderStatus === "DELIVERED") {
                return callback(null, { success: true, message: "Already updated" });
            }
            await OrderModel.updateOne(
                { _id: orderId, orderStatus: { $in: BEFORE_OUT } },
                { $set: { orderStatus: "OUT_FOR_DELIVERY" } }
            );
            return callback(null, { success: true, message: "Order is out for delivery" });
        }

        // DELIVERED (also accepted if the earlier OUT_FOR_DELIVERY update was lost)
        if (order.orderStatus !== "DELIVERED") {
            const when = deliveredAt && !Number.isNaN(Date.parse(deliveredAt)) ? new Date(deliveredAt) : new Date();
            await OrderModel.updateOne(
                { _id: orderId, orderStatus: { $in: [...BEFORE_OUT, "OUT_FOR_DELIVERY"] } },
                { $set: { orderStatus: "DELIVERED", deliveredAt: when, "items.$[].status": "DELIVERED" } }
            );
        }

        // cash was handed over at the door -> COD payment is now paid
        await PaymentModel.updateOne(
            { orderId, paymentMethod: "COD", paymentStatus: "PENDING" },
            { $set: { paymentStatus: "SUCCESS", isPaid: true, paymentDate: new Date() } }
        );

        return callback(null, { success: true, message: "Order delivered" });
    } catch (error) {
        console.error("UpdateOrderStatus error:", error.message);
        return callback({ code: grpc.status.INTERNAL, message: "Internal error" });
    }
};

const startOrderGrpcServer = () => {
    const server = new grpc.Server();
    server.addService(orderProto.OrderService.service, { UpdateOrderStatus });

    server.bindAsync(`0.0.0.0:${Envs.ORDER_GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (error) => {
        if (error) {
            console.error("Order gRPC failed to start:", error.message);
            return;
        }
        console.log(`Order gRPC server running on ${Envs.ORDER_GRPC_PORT}`);
    });
};

export default startOrderGrpcServer;