const Ratelimit = (windowMs, max, cooldownMs) => {
    const requests = new Map();
    const cooldowns = new Map();

    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();

        // Check if IP is in cooldown
        const cooldownUntil = cooldowns.get(key);

        if (cooldownUntil && now < cooldownUntil) {
            const remainingTime = Math.ceil(
                (cooldownUntil - now) / 1000
            );
            const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);

            const minutes = Math.floor(remainingSeconds / 60);
            const seconds = remainingSeconds % 60;

            return res.status(429).json({
                success: false,
                message: `Too many requests. Try again in ${minutes}:${String(seconds).padStart(2, "0")}`
            });
        }

        // Cooldown expired
        if (cooldownUntil && now >= cooldownUntil) {
            cooldowns.delete(key);
            requests.delete(key);
        }

        if (!requests.has(key)) {
            requests.set(key, []);
        }

        const timestamps = requests.get(key);

        // Remove expired requests
        const validRequests = timestamps.filter(
            time => now - time < windowMs
        );

        if (validRequests.length >= max) {

            // Start cooldown
            cooldowns.set(
                key,
                now + cooldownMs
            );

            return res.status(429).json({
                success: false,
                message: "Too many requests. Please try again after 5 minutes."
            });
        }

        validRequests.push(now);
        requests.set(key, validRequests);

        next();
    };
};

export default Ratelimit;