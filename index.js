require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------
// API Targets
// -----------------
const PHPTRAVELS_TARGET = 'https://api.phptravels.com';
const IATA_LOCAL_API_TARGET = 'http://ota-node-server-2-1.onrender.com/api';
const IATA_LOCAL_PING = 'http://ota-node-server-2-1.onrender.com/ping';

// -----------------
// Middleware
// -----------------
app.use(morgan('dev'));
app.use(bodyParser.json()); // global parser for all /api requests

// -----------------
// Status Route
// -----------------
app.get('/status', async (req, res) => {
    const start = Date.now();
    try {
        const response = await axios.get(IATA_LOCAL_PING);
        const latency = Date.now() - start;
        res.json({
            service: 'iatalocal',
            status: 'ok',
            latency: `${latency}ms`,
            response: response.data
        });
    } catch (err) {
        const latency = Date.now() - start;
        res.status(503).json({
            service: 'iatalocal',
            status: 'error',
            latency: `${latency}ms`,
            error: err.message
        });
    }
});

// -----------------
// Smart iatalocal handler
// -----------------
app.use('/api', async (req, res, next) => {
    if (req.originalUrl.toLowerCase().includes('/flights/iatalocal/')) {
        console.log('[ADAPTER] Intercepted iatalocal request');
        if (!req.body) return res.status(400).json({ error: 'Empty request body' });

        try {
            const payload = mapPhpToIataLocalRequest(req.body);
            const response = await axios.post(IATA_LOCAL_API_TARGET, payload, {
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
            });
            const result = mapIataLocalToPhpResponse(response.data, req.body.triptypename);
            return res.json(result);
        } catch (err) {
            console.error('[ADAPTER] iatalocal error:', err.message || err);
            return res.status(500).json([]);
        }
    }
    next();
});

// -----------------
// Proxy Duffel / PHPTravels
// -----------------
app.use('/api', createProxyMiddleware({
    target: PHPTRAVELS_TARGET,
    changeOrigin: true,
    selfHandleResponse: false,
    onProxyReq(proxyReq, req) {
        if (req.body && Object.keys(req.body).length) {
            const bodyData = JSON.stringify(req.body);
            proxyReq.setHeader('Content-Type', 'application/json');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
            proxyReq.end();
        }
    }
}));

// -----------------
// Mapping Functions
// -----------------
function convertDateToDDMonYYYY(yyyyMmDd) {
    if (!yyyyMmDd) return "";
    const [year, month, day] = yyyyMmDd.split('-');
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const idx = parseInt(month, 10) - 1;
    if (idx < 0 || idx > 11) return "";
    return `${day}-${months[idx]}-${year}`;
}

function mapPhpToIataLocalRequest(php) {
    const fromCode = (php.origin.split(' - ')[1] || php.origin).trim();
    const toCode = (php.destination.split(' - ')[1] || php.destination).trim();
    return {
        is_combo: 0,
        CMND: "_FLIGHTSEARCH_",
        TRIP: php.triptypename === 'round' ? "RT" : "OW",
        FROM: fromCode,
        DEST: toCode,
        JDT: convertDateToDDMonYYYY(php.departure_date),
        RDT: php.return_date ? convertDateToDDMonYYYY(php.return_date) : "",
        ACLASS: "Y",
        AD: parseInt(php.adults, 10) || 0,
        CH: parseInt(php.childrens, 10) || 0,
        INF: parseInt(php.infants, 10) || 0,
        Umrah: "0"
    };
}

function formatDuration(totalMinutes) {
    if (isNaN(totalMinutes)) return "00:00";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function createPhpSegments(trip) {
    const duration = formatDuration(trip.fDursec);
    return trip.fLegs.map(leg => ({
        img: trip.stAirCode,
        flight_no: leg.xFlight,
        airline: trip.stAirline,
        class: leg.xClass,
        baggage: trip.fBag.replace('Baggage:', '').trim(),
        cabin_baggage: "7 Kg",
        departure_airport: leg.xFrom,
        departure_code: leg.xFrom,
        departure_date: leg.DTime.substring(0, 10),
        departure_time: leg.DTime.substring(11, 16),
        arrival_airport: leg.xDest,
        arrival_code: leg.xDest,
        arrival_date: leg.ATime.substring(0, 10),
        arrival_time: leg.ATime.substring(11, 16),
        duration_time: duration,
        total_duration: duration,
        currency: "BDT",
        actual_currency: "BDT",
        price: trip.fFare.toString(),
        actual_price: (trip.fBFare || 0).toString(),
        adult_price: trip.fFare.toString(),
        child_price: trip.fFare.toString(),
        infant_price: trip.fFare.toString(),
        booking_data: {
            booking_id: trip.fAMYid,
            fSoft: trip.fSoft,
            fGDSid: trip.fGDSid,
            transit1: trip.fTransit1 || "",
            transit2: trip.fTransit2 || "",
            transit_ap1: trip.fTransitAP1 || "",
            transit_ap2: trip.fTransitAP2 || "",
            aircraft_model: trip.fModel || "",
            source: trip.csource || "GDS"
        },
        supplier: "iatalocal",
        type: trip.fReturn ? "round" : "oneway",
        refundable: trip.fRefund !== "NONREFUND",
        redirect_url: "",
        color: "#0d3981"
    }));
}

function mapIataLocalToPhpResponse(resp, tripType) {
    if (!resp.success || !resp.data || !resp.data.Trips) return [];
    const trips = resp.data.Trips;

    if (tripType === 'oneway') {
        return trips.map(t => ({ segments: [createPhpSegments(t)] }));
    }

    const outbound = new Map();
    const inbound = new Map();

    trips.forEach(trip => {
        const key = `${trip.fSoft}-${trip.fGDSid}`;
        if (trip.fReturn) inbound.set(key, trip);
        else outbound.set(key, trip);
    });

    const results = [];
    outbound.forEach((out, key) => {
        if (inbound.has(key)) {
            results.push({
                segments: [createPhpSegments(out), createPhpSegments(inbound.get(key))]
            });
        }
    });
    return results;
}

// -----------------
// Start server
// -----------------
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
