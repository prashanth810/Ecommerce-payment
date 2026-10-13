import express from "express";
import Authmiddleware from "../middlewares/Authmiddleware.js";
import Ratelimit from "../middlewares/Ratelimit.js";
import { Placeorder, Getmyorders, Getsingleorder } from "../controllers/Ordercontrollers.js";

const Orderroute = express.Router();

Orderroute.post("/order/place", Ratelimit(60 * 1000, 10, 5 * 60 * 1000), Authmiddleware, Placeorder);
Orderroute.get("/order/my-orders", Ratelimit(60 * 1000, 20, 5 * 60 * 1000), Authmiddleware, Getmyorders);
Orderroute.get("/order/:orderId", Ratelimit(60 * 1000, 20, 5 * 60 * 1000), Authmiddleware, Getsingleorder);

export default Orderroute;