import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGULAR_TTF = path.join(__dirname, "../assets/fonts/NotoSans-Regular.ttf");
const BOLD_TTF = path.join(__dirname, "../assets/fonts/NotoSans-Bold.ttf");
const HAS_FONT = fs.existsSync(REGULAR_TTF) && fs.existsSync(BOLD_TTF);

// ---- your business details (empty ones are skipped in the PDF) ----
const BRAND = {
    name: "Freshies",
    address: "",
    email: "",
    phone: "",
    website: "",
    gstin: "",
};

const COLOR = {
    primary: "#059669",
    text: "#111827",
    body: "#4b5563",
    muted: "#6b7280",
    line: "#e5e7eb",
    head: "#f3f4f6",
};

const DELIVERY_LABEL = { free: "Free", standard: "Standard", express: "Express" };
const DELIVERY_DAYS = { free: 3, standard: 2, express: 1 };

const LEFT = 35;
const RIGHT = 560;
const WIDTH = RIGHT - LEFT;
const PAGE_BOTTOM = 806; // content must end above this line (A4 height 841 - 35pt margin)

// table columns (numbers are right aligned, the amount ends at x = 533)
const COLS = {
    desc: { x: 47, w: 210 },
    units: { x: 263, w: 50 },
    price: { x: 317, w: 68 },
    gst: { x: 389, w: 58 },
    amount: { x: 451, w: 80 },
};

const amountText = (value) =>
    Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const money = (value) => `${HAS_FONT ? "₹" : "Rs. "}${amountText(value)}`;

const fmtDate = (value) =>
    value
        ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
        : "-";

const addDays = (value, days) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setDate(date.getDate() + days);
    return date;
};

// INV-20261014-A2F3C9
export const getInvoiceNumber = (order) => {
    const date = new Date(order.createdAt);
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    return `INV-${stamp}-${String(order._id).slice(-6).toUpperCase()}`;
};

// returns a PDFKit document, the controller pipes it to the response and ends it
export const createInvoicePdf = ({ order, payment }) => {
    const invoiceNo = getInvoiceNumber(order);

    const doc = new PDFDocument({
        size: "A4",
        margin: 35,
        info: { Title: `Invoice ${invoiceNo}`, Author: BRAND.name },
    });

    if (HAS_FONT) {
        doc.registerFont("Body", REGULAR_TTF);
        doc.registerFont("BodyBold", BOLD_TTF);
    }
    const REG = HAS_FONT ? "Body" : "Helvetica";
    const BOLD = HAS_FONT ? "BodyBold" : "Helvetica-Bold";

    const isCod = order.paymentMethod === "COD";
    const paid = payment?.paymentStatus === "SUCCESS";
    const statusLabel = paid ? "PAID" : isCod ? "PAY ON DELIVERY" : "PAYMENT PENDING";
    const methodLabel = isCod ? "Cash on Delivery" : "Online payment (Razorpay)";
    const deliveryLabel = DELIVERY_LABEL[order.deliveryId] || order.deliveryId;
    const address = order.address || {};
    const shortOrderId = String(order._id).slice(-8).toUpperCase();
    const days = DELIVERY_DAYS[order.deliveryId];
    const deliveryBy = days ? addDays(order.createdAt, days) : null;

    // ---------- small helpers ----------
    const label = (text, x, y, options = {}) =>
        doc.font(REG).fontSize(8.5).fillColor(COLOR.muted).text(text, x, y, options);

    const divider = (y) =>
        doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.7).strokeColor(COLOR.line).stroke();

    const drawLines = (lines, x, startY, align) => {
        let y = startY;
        lines.forEach((line, index) => {
            doc.font(index === 0 ? BOLD : REG)
                .fontSize(index === 0 ? 10.5 : 9.5)
                .fillColor(index === 0 ? COLOR.text : COLOR.body)
                .text(line, x, y, { width: 240, align });
            y = doc.y + (index === 0 ? 4 : 3);
        });
        return y;
    };

    let y = 0;
    const ensure = (height) => {
        if (y + height > PAGE_BOTTOM) {
            doc.addPage();
            y = 35;
        }
    };

    // ---------- header: brand (left) + invoice title (right) ----------
    const brandY = 44;
    doc.circle(LEFT + 6, brandY, 6).fill(COLOR.primary);
    doc.font(BOLD).fontSize(22).fillColor(COLOR.text)
        .text(BRAND.name, LEFT + 20, brandY, { baseline: "middle", lineBreak: false });

    doc.font(BOLD).fontSize(28).fillColor(COLOR.text)
        .text("Invoice", 305, 30, { width: 255, align: "right" });
    doc.font(BOLD).fontSize(11).fillColor(COLOR.text)
        .text(`#${invoiceNo}`, 305, 68, { width: 255, align: "right" });

    divider(92);

    // ---------- order id + dates ----------
    label("Order ID", LEFT, 108);
    doc.font(BOLD).fontSize(10).fillColor(COLOR.text).text(`#${shortOrderId}`, LEFT, 121);

    label("Issued Date", 335, 108, { width: 115, align: "right" });
    doc.font(BOLD).fontSize(10).fillColor(COLOR.text)
        .text(fmtDate(order.createdAt), 335, 121, { width: 115, align: "right" });

    label("Delivery By", 455, 108, { width: 105, align: "right" });
    doc.font(BOLD).fontSize(10).fillColor(COLOR.text)
        .text(fmtDate(deliveryBy), 455, 121, { width: 105, align: "right" });

    divider(148);

    // ---------- from (left) / to (right) ----------
    label("From", LEFT, 164);
    label("To", 305, 164, { width: 255, align: "right" });

    const fromLines = [
        BRAND.name,
        BRAND.address,
        BRAND.email,
        BRAND.phone,
        BRAND.website,
        BRAND.gstin ? `GSTIN: ${BRAND.gstin}` : "",
    ].filter(Boolean);

    const toLines = [
        address.full_name,
        [address.building_number, address.street].filter(Boolean).join(", "),
        address.landmark,
        [address.city, address.state, address.pincode].filter(Boolean).join(", "),
        address.country,
        address.phone,
    ].filter(Boolean);

    const fromEnd = drawLines(fromLines, LEFT, 180, "left");
    const toEnd = drawLines(toLines, 305, 180, "right");

    y = Math.max(fromEnd, toEnd) + 10;
    divider(y);
    y += 24;

    // ---------- items table ----------
    const drawHead = (top) => {
        doc.roundedRect(LEFT, top, WIDTH, 30, 6).fill(COLOR.head);
        doc.font(REG).fontSize(9.5).fillColor(COLOR.text);
        doc.text("Description", COLS.desc.x, top + 10, { width: COLS.desc.w });
        doc.text("Units", COLS.units.x, top + 10, { width: COLS.units.w, align: "center" });
        doc.text("Price", COLS.price.x, top + 10, { width: COLS.price.w, align: "right" });
        doc.text("GST", COLS.gst.x, top + 10, { width: COLS.gst.w, align: "right" });
        doc.text("Amount", COLS.amount.x, top + 10, { width: COLS.amount.w, align: "right" });
        return top + 30;
    };

    // the order stores one tax total, so the GST of each line is its share of it
    const taxRatio = Number(order.subtotal) > 0 ? Number(order.tax) / Number(order.subtotal) : 0;

    y = drawHead(y);

    (order.items || []).forEach((item) => {
        const lineAmount = Number(item.price) * Number(item.quantity);
        const lineTax = lineAmount * taxRatio;
        const name = item.name || "Item";

        doc.font(REG).fontSize(10);
        const nameHeight = doc.heightOfString(name, { width: COLS.desc.w });
        const rowHeight = Math.max(36, nameHeight + (item.weight ? 14 : 0) + 20);

        if (y + rowHeight > PAGE_BOTTOM - 40) {
            doc.addPage();
            y = drawHead(50);
        }

        doc.font(REG).fontSize(10).fillColor(COLOR.text).text(name, COLS.desc.x, y + 10, { width: COLS.desc.w });
        if (item.weight) {
            doc.font(REG).fontSize(8.5).fillColor(COLOR.muted)
                .text(item.weight, COLS.desc.x, y + 12 + nameHeight, { width: COLS.desc.w });
        }

        doc.font(REG).fontSize(10).fillColor(COLOR.text);
        doc.text(String(item.quantity), COLS.units.x, y + 10, { width: COLS.units.w, align: "center" });
        doc.text(money(item.price), COLS.price.x, y + 10, { width: COLS.price.w, align: "right" });
        doc.text(amountText(lineTax), COLS.gst.x, y + 10, { width: COLS.gst.w, align: "right" });
        doc.text(money(lineAmount), COLS.amount.x, y + 10, { width: COLS.amount.w, align: "right" });

        y += rowHeight;
        divider(y);
    });

    // ---------- summary rows (the last one is the total) ----------
    const summaryRow = (text, value, { bold = false, size = 10 } = {}) => {
        const textY = y + (bold ? 11 : 8);
        doc.font(bold ? BOLD : REG).fontSize(size).fillColor(bold ? COLOR.text : COLOR.body)
            .text(text, COLS.desc.x, textY, { width: 240 });
        doc.fillColor(COLOR.text)
            .text(value, COLS.amount.x - 100, textY, { width: COLS.amount.w + 100, align: "right" });
        y += bold ? 34 : 26;
        divider(y);
    };

    ensure(112);
    summaryRow("Subtotal", money(order.subtotal));
    summaryRow(`Delivery (${deliveryLabel})`, money(order.deliveryCharge));
    summaryRow("GST / Tax", money(order.tax));
    summaryRow("Total Amount", money(order.total), { bold: true, size: 11 });

    // ---------- note box ----------
    y += 8;

    const noteBody =
        isCod && !paid
            ? `Cash on Delivery: please pay ${money(order.total)} to the delivery partner at the time of delivery.`
            : "Thank you for shopping with us. Please keep this invoice for returns or support queries.";

    doc.font(REG).fontSize(9);
    const noteHeight = doc.heightOfString(`Note: ${noteBody}`, { width: WIDTH - 28 }) + 4;

    // payment / signature section height: title(20) + gap(4) + 4 lines×13px + signature block(65)
    const payLines = [
        methodLabel,
        payment?.razorpay_payment_id ? `Transaction ID : ${payment.razorpay_payment_id}` : "",
        paid ? `Paid on : ${fmtDate(payment?.paymentDate)}` : "",
        `Status : ${statusLabel}`,
    ].filter(Boolean);

    const payBlockHeight = 20 + payLines.length * 13 + 65;

    // ensure the ENTIRE remaining section (note + gap + payment) fits on this page
    const totalRemaining = noteHeight + 24 + 14 + payBlockHeight;
    ensure(totalRemaining);

    doc.roundedRect(LEFT, y, WIDTH, noteHeight + 24, 6).lineWidth(0.7).strokeColor(COLOR.line).stroke();
    doc.font(BOLD).fontSize(9).fillColor(COLOR.text)
        .text("Note: ", LEFT + 14, y + 12, { width: WIDTH - 28, continued: true });
    doc.font(REG).fillColor(COLOR.body).text(noteBody, { width: WIDTH - 28 });

    y += noteHeight + 24 + 14;

    // ---------- payment method (left) + signature (right) ----------
    doc.font(BOLD).fontSize(13).fillColor(COLOR.text).text("Payment Method", LEFT, y);

    let lineY = y + 24;
    payLines.forEach((line) => {
        doc.font(REG).fontSize(9).fillColor(COLOR.body).text(line, LEFT, lineY, { width: 280 });
        lineY = doc.y + 3;
    });

    doc.font("Times-Italic").fontSize(22).fillColor(COLOR.text)
        .text(BRAND.name, 345, y + 2, { width: 200, align: "right" });
    doc.font(BOLD).fontSize(10).fillColor(COLOR.text)
        .text("Authorized Signatory", 345, y + 40, { width: 200, align: "right" });
    doc.font(REG).fontSize(8).fillColor(COLOR.muted)
        .text("This is a computer generated invoice.", 345, y + 55, { width: 200, align: "right" });

    return doc;
};
