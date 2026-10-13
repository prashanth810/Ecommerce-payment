import express, { application } from "express";
import cors from "cors";
import morgan from "morgan";
import Envs from "./utils/Envs.js";
import ConnectionDb from "./config/ConnectDb.js";
import Paymentroute from "./routes/Paymentroutes.js";
import Orderroute from "./routes/Orderroute.js";




const app = express();
const PORT = Envs.PORT;

app.use(cors());
app.use(morgan('dev'));

app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true, limit: "10mb" }));


app.get("/", (req, res) => {
    return res.status(200).json({ success: true, message: "Server from paymentbackend !!!" });
})

// payment routes
app.use('/api/auth/v5', Paymentroute);
app.use('/api/auth/v5', Orderroute);


// db connecion 
ConnectionDb().then(() => {
    app.listen(PORT, () => {
        console.log(`server started at http://localhost:${PORT}`);
    });
})
    .catch((error) => {
        console.error(error.message)
    })
