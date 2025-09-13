// proxy-server.js
require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_URL = 'https://api.phptravels.com';

// --- Middleware ---
// Log incoming requests
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Custom logging middleware for request and response
app.use((req, res, next) => {
    console.log('--- Incoming Request ---');
    console.log(`${req.method} ${req.originalUrl}`);
    console.log('Query:', req.query);
    // console.log('Headers:', req.headers);
    if (req.body && Object.keys(req.body).length) {
        console.log('Body:', req.body);
    }
    // Hook into the response to log it
    const originalSend = res.send.bind(res);
    res.send = (body) => {
        console.log('--- Outgoing Response ---');
        console.log('Status:', res.statusCode);
        console.log('Body:', body);
        return originalSend(body);
    };

    next();
});

// --- Proxy Setup ---
app.use(
    '/api', // all requests starting with /api will be proxied
    createProxyMiddleware({
        target: TARGET_URL,
        changeOrigin: true,
        pathRewrite: {
            '^/api': '', // remove /api prefix when forwarding to target
        },
        onProxyReq: (proxyReq, req, res) => {
            // If original request has JSON body, forward it
            if (req.body && Object.keys(req.body).length) {
                const bodyData = JSON.stringify(req.body);
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        },
        onProxyRes: (proxyRes, req, res) => {
            // Optionally, you can log proxy response here too
            let body = [];
            proxyRes.on('data', (chunk) => {
                body.push(chunk);
            });
            proxyRes.on('end', () => {
                body = Buffer.concat(body).toString();
                console.log('--- Proxy Response ---');
                console.log('Status:', proxyRes.statusCode);
                console.log('Body:', body);
            });
        },
    })
);

// Start server
app.listen(PORT, () => {
    console.log(`Proxy server running at http://localhost:${PORT}`);
});