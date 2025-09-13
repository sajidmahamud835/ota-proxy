// proxy-server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Targets ---
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const IATA_LOCAL_REDIRECT = 'https://ota-proxy.onrender.com'; // redirect IATA Local requests here

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
        console.log('Body:', body);
        return originalSend(body);
    };

    next();
});

// =========================================================================
// Conditional Proxy Middleware
// =========================================================================
app.use(
    '/api',
    (req, res, next) => {
        // If request is for IATA Local, redirect to IATA_LOCAL_REDIRECT
        if (req.originalUrl.toLowerCase().includes('/flights/iatalocal')) {
            createProxyMiddleware({
                target: IATA_LOCAL_REDIRECT,
                changeOrigin: true,
                pathRewrite: { '^/api': '' },
                onProxyReq: (proxyReq, req) => {
                    if (req.body && Object.keys(req.body).length) {
                        const bodyData = JSON.stringify(req.body);
                        proxyReq.setHeader('Content-Type', 'application/json');
                        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                        proxyReq.write(bodyData);
                    }
                }
            })(req, res, next);
        } else {
            // All other requests go to PHPTravels/Duffel
            createProxyMiddleware({
                target: PHPTRAVELS_TARGET,
                changeOrigin: true,
                pathRewrite: { '^/api': '' },
                onProxyReq: (proxyReq, req) => {
                    if (req.body && Object.keys(req.body).length) {
                        const bodyData = JSON.stringify(req.body);
                        proxyReq.setHeader('Content-Type', 'application/json');
                        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                        proxyReq.write(bodyData);
                    }
                }
            })(req, res, next);
        }
    }
);

// --- Root ---
app.get("/", (req, res) => res.send("Proxy Server Running"));

// --- Start Server ---
app.listen(PORT, () => console.log(`Proxy server running at http://localhost:${PORT}`));
