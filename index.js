require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';

// --- Logging ---
app.use(morgan('dev'));

// --- RAW Proxy for PHPTravels (Duffel, Amy, etc.) ---
app.use(
    '/api',
    express.raw({ type: '*/*' }),
    createProxyMiddleware({
        target: PHPTRAVELS_TARGET,
        changeOrigin: true,
        pathRewrite: { '^/api': '' },
        selfHandleResponse: false,
        onProxyReq: (proxyReq, req) => {
            if (req.body && req.body.length) {
                proxyReq.setHeader('Content-Length', req.body.length);
                proxyReq.write(req.body);
            }
        }
    })
);

// --- Root ---
app.get("/", (req, res) => {
    res.send("Duffel Proxy Test OK");
});

// --- Start ---
app.listen(PORT, () => {
    console.log(`Proxy running at http://localhost:${PORT}`);
});
