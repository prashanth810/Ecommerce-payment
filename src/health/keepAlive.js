const toHealthUrl = (base) => {
    const clean = base.trim().replace(/\/+$/, "");
    return clean.endsWith("/health") ? clean : `${clean}/health`;
};

const pingOnce = async (url) => {
    const started = Date.now();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        console.log(`[health] ${res.ok ? "OK" : "FAIL"} ${url} ${res.status} ${Date.now() - started}ms`);
    } catch (error) {
        console.log(`[health] FAIL ${url} ${error.message}`);
    }
};

export const startKeepAlive = () => {
    if (process.env.KEEP_ALIVE_ENABLED === "false") return;

    const self = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
    const others = (process.env.HEALTH_PING_URLS || "").split(",").filter((s) => s.trim());

    const urls = [...new Set([self, ...others].filter(Boolean).map(toHealthUrl))];

    // Local machine has no public URL, so nothing runs while developing
    if (urls.length === 0) return;

    const minutes = Number(process.env.KEEP_ALIVE_INTERVAL_MIN) || 5;

    const timer = setInterval(() => urls.forEach(pingOnce), minutes * 60 * 1000);
    timer.unref();

    console.log(`[health] pinging every ${minutes} min:`, urls.join(", "));
};