require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// --- API Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const IATA_LOCAL_REDIRECT = 'https://ota-proxy-dev.onrender.com/api'; // IATA Local redirect target

// --- Middleware ---
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Logging middleware ---
app.use((req, res, next) => {
    console.log('--- Incoming Request ---');
    console.log(`${req.method} ${req.originalUrl}`);
    console.log('Query:', req.query);
    if (req.body && Object.keys(req.body).length) console.log('Body:', req.body);

    const originalSend = res.send.bind(res);
    res.send = (body) => {
        console.log('--- Outgoing Response ---');
        console.log('Status:', res.statusCode);
        // Only log body if small to avoid flooding logs
        if (body && body.length < 5000) console.log('Body:', body);
        return originalSend(body);
    };
    next();
});

// =========================================================================
// Conditional Proxy Middleware for IATA Local + Duffel
// =========================================================================
app.use('/api', (req, res, next) => {
    const isIata = req.originalUrl.toLowerCase().includes('/flights/iatalocal');

    const target = isIata ? IATA_LOCAL_REDIRECT : PHPTRAVELS_TARGET;

    createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite: (path, req) => {
            if (isIata) {
                // Remove "/api/flights/iatalocal" prefix, keep /api/v1/search
                return path.replace(/^\/api\/flights\/iatalocal/, '');
            }
            // For other APIs, remove just /api prefix
            return path.replace(/^\/api/, '');
        },
        onProxyReq: (proxyReq, req) => {
            if (req.body && Object.keys(req.body).length) {
                const bodyData = JSON.stringify(req.body);
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        },
        onProxyRes: (proxyRes, req, res) => {
            let body = [];
            proxyRes.on('data', (chunk) => body.push(chunk));
            proxyRes.on('end', () => {
                body = Buffer.concat(body).toString();
                console.log('--- Proxy Response ---');
                console.log('Status:', proxyRes.statusCode);
                if (body.length < 5000) console.log('Body:', body);
            });
        }
    })(req, res, next);
});

// =========================================================================
// Root Route
// =========================================================================
app.get('/', (req, res) => res.send('OTA Proxy Server Running'));

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`OTA Proxy server running at http://localhost:${PORT}`);
});
