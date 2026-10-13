import jwt from "jsonwebtoken";
import Envs from "../utils/Envs.js";

const Authmiddleware = (req, res, next) => {
    try {
        const token = req?.headers?.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({ success: false, message: "No token available or unauthorized !!!" });
        }

        const decode = jwt.verify(token, Envs.JWT_SECRET);

        req.user = decode;
        next();
    }
    catch (error) {
        return res.status(401).json({ success: false, message: "Invalid or expired token !!!" });
    }
}

export default Authmiddleware;